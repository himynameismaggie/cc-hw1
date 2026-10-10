import {SQSClient, ReceiveMessageCommand, DeleteMessageCommand} from "@aws-sdk/client-sqs";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {DynamoDBDocumentClient, BatchGetCommand} from "@aws-sdk/lib-dynamodb";
import {SESv2Client, SendEmailCommand} from "@aws-sdk/client-sesv2";
import { Client } from "@opensearch-project/opensearch";
import awsSigner from "@opensearch-project/opensearch/aws-v3";
const { AwsSigv4Signer } = awsSigner;
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const REGION = process.env.AWS_REGION_NAME || "us-east-1";
const QUEUE_URL = process.env.QUEUE_URL;
const TABLE = process.env.DYNAMODB_TABLE || "yelp-restaurants";
const OPENSEARCH_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
const SES_SENDER = process.env.SES_SENDER_EMAIL;

if (!QUEUE_URL || !OPENSEARCH_ENDPOINT || !SES_SENDER) {
    throw new Error("Missing LF2 environment variables");
}

const sqs = new SQSClient({ region: REGION });

const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION })
);

const ses = new SESv2Client({ region: REGION });

const credentials = defaultProvider();

const search = new Client({
    ...AwsSigv4Signer({
        region: REGION,
        service: "es",
        getCredentials: () => credentials()
    }),
    node: OPENSEARCH_ENDPOINT
});

async function findRestaurants(cuisine) {
    const response = await search.search({
        index: "restaurants",
        body: {
            size: 3,
            query: {
                function_score: {
                    query: {
                        term: {
                            Cuisine: cuisine
                        }
                    },
                    random_score: {
                        seed: Math.floor(Math.random() * 2147483647),
                        field: "_seq_no"
                    },
                    boost_mode: "replace"
                }
            },
            _source: ["RestaurantID"]
        }
    });

    const hits = response.body.hits?.hits || [];

    return [
        ...new Set(
            hits.map(hit => hit._source?.RestaurantID)
                .filter(Boolean)
        )
    ];
}

async function getRestaurantDetails(ids) {
    if (ids.length === 0) return [];

    let keys = ids.map(businessId => ({ businessId }));
    const results = [];

    for (let attempt = 0; attempt < 5 && keys.length; attempt++) {
        const response = await dynamo.send(
            new BatchGetCommand({
                RequestItems: {
                    [TABLE]: {
                        Keys: keys
                    }
                }
            })
        );

        results.push(...(response.Responses?.[TABLE] || []));

        keys = response.UnprocessedKeys?.[TABLE]?.Keys || [];

        if (keys.length) {
            await new Promise(resolve =>
                setTimeout(resolve, 200 * (2 ** attempt))
            );
        }
    }

    if (keys.length) {
        throw new Error("DynamoDB BatchGet still has unprocessed keys");
    }

    return ids
        .map(id => results.find(r => r.businessId === id))
        .filter(Boolean);
}

function buildEmail(request, restaurants) {
    const heading =
        `Here are your ${request.cuisine} restaurant suggestions!`;

    const introduction = [
        "Thank you for using Dining Concierge.",
        "",
        `Location: ${request.location}`,
        `Cuisine: ${request.cuisine}`,
        `Date: ${request.diningDate}`,
        `Time: ${request.diningTime}`,
        `Party size: ${request.partySize}`,
        "",
        "Our restaurant recommendations:",
        ""
    ];

    const suggestions = restaurants.map((restaurant, i) =>
        [
            `${i + 1}. ${restaurant.name}`,
            `Address: ${restaurant.address}`,
            `Rating: ${restaurant.rating}/5`,
            `Review count: ${restaurant.reviewCount}`,
            `ZIP code: ${restaurant.zipCode}`
        ].join("\n")
    );

    return {
        subject: heading,
        text: [
            ...introduction,
            ...suggestions,
            "",
            "We hope you enjoy your meal!",
            "Dining Concierge"
        ].join("\n")
    };
}

async function sendEmail(recipient, subject, text) {
    return ses.send(new SendEmailCommand({
        FromEmailAddress: SES_SENDER,
        Destination: {
            ToAddresses: [recipient]
        },
        Content: {
            Simple: {
                Subject: {
                    Data: subject,
                    Charset: "UTF-8"
                },
                Body: {
                    Text: {
                        Data: text,
                        Charset: "UTF-8"
                    }
                }
            }
        }
    }));
}

async function processMessage(message) {
    const request = JSON.parse(message.Body);

    const required = [
        "cuisine",
        "location",
        "partySize",
        "diningDate",
        "diningTime",
        "email"
    ];

    for (const field of required) {
        if (
            request[field] === undefined ||
            request[field] === null ||
            String(request[field]).trim() === ""
        ) {
            throw new Error(`Missing request field: ${field}`);
        }
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email)) {
        throw new Error("Invalid recipient email");
    }

    console.log("Processing dining request", {
        requestId: request.requestId,
        cuisine: request.cuisine
    });

    const ids = await findRestaurants(request.cuisine);

    if (ids.length === 0) {
        throw new Error(
            `No restaurants found for cuisine: ${request.cuisine}`
        );
    }

    const restaurants = await getRestaurantDetails(ids);

    if (restaurants.length === 0) {
        throw new Error(
            "OpenSearch IDs could not be found in DynamoDB"
        );
    }

    const email = buildEmail(request, restaurants);

    const result = await sendEmail(
        request.email,
        email.subject,
        email.text
    );

    console.log("SES accepted email", {
        requestId: request.requestId,
        messageId: result.MessageId
    });

    // delete only after SES has accepted the email.
    await sqs.send(new DeleteMessageCommand({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle
    }));

    return result.MessageId;
}

export const handler = async () => {
    const response = await sqs.send(
        new ReceiveMessageCommand({
            QueueUrl: QUEUE_URL,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 0,
            VisibilityTimeout: 180,
            MessageSystemAttributeNames: [
                "ApproximateReceiveCount"
            ]
        })
    );

    const messages = response.Messages || [];

    console.log(`Received ${messages.length} SQS messages`);

    let sent = 0;
    let failed = 0;

    for (const message of messages) {
        try {
            await processMessage(message);
            sent++;
        } catch (error) {
            failed++;

            console.error("Failed to process SQS message", {
                messageId: message.MessageId,
                error: error.message
            });
        }
    }
    return {
        received: messages.length,
        sent,
        failed
    };
};
