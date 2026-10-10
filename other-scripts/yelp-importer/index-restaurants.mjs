import "dotenv/config";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {DynamoDBDocumentClient, ScanCommand} from "@aws-sdk/lib-dynamodb";
import {Client} from "@opensearch-project/opensearch";
import awsSigner from "@opensearch-project/opensearch/aws-v3";
const { AwsSigv4Signer } = awsSigner;
import {defaultProvider} from "@aws-sdk/credential-provider-node";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.DYNAMODB_TABLE || "yelp-restaurants";
const ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
const INDEX = "restaurants";

if (!ENDPOINT) {
    throw new Error("Missing OPENSEARCH_ENDPOINT");
}

const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION })
);

const search = new Client({
    ...AwsSigv4Signer({
        region: REGION,
        service: "es",
        getCredentials: () => defaultProvider()()
    }),
    node: ENDPOINT
});

async function ensureIndex() {
    const exists = await search.indices.exists({
        index: INDEX
    });

    if (exists.body === true) {
        console.log(`Index "${INDEX}" already exists`);
        return;
    }

    await search.indices.create({
        index: INDEX,
        body: {
            settings: {
                number_of_shards: 1,
                number_of_replicas: 0
            },
            mappings: {
                properties: {
                    RestaurantID: {
                        type: "keyword"
                    },
                    Cuisine: {
                        type: "keyword"
                    }
                }
            }
        }
    });

    console.log(`Created index "${INDEX}"`);
}

async function loadRestaurants() {
    const records = [];
    let lastKey;

    do {
        const result = await dynamo.send(
            new ScanCommand({
                TableName: TABLE,
                ProjectionExpression:
                    "businessId, cuisine",
                ExclusiveStartKey: lastKey
            })
        );

        for (const item of result.Items || []) {
            if (
                typeof item.businessId === "string" &&
                typeof item.cuisine === "string" &&
                item.businessId &&
                item.cuisine
            ) {
                records.push({
                    RestaurantID: item.businessId,
                    Cuisine: item.cuisine
                });
            }
        }

        lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    console.log(
        `Loaded ${records.length} restaurants from DynamoDB`
    );

    return records;
}

async function uploadBatch(restaurants) {
    const operations = [];

    for (const restaurant of restaurants) {
        operations.push({
            index: {
                _index: INDEX,
                _id: restaurant.RestaurantID
            }
        });

        operations.push(restaurant);
    }

    const result = await search.bulk({
        body: operations,
        refresh: "wait_for"
    });

    if (result.body.errors) {
        const failures = result.body.items
            .filter(item => {
                const operation = item.index;
                return operation?.error ||
                    operation?.status >= 300;
            })
            .map(item => item.index);

        console.error(
            "Bulk indexing failures:",
            failures.slice(0, 5)
        );

        throw new Error(
            `${failures.length} documents failed to index`
        );
    }
}

async function main() {
    await ensureIndex();

    const restaurants = await loadRestaurants();

    if (restaurants.length === 0) {
        throw new Error(
            "No valid restaurant records found in DynamoDB"
        );
    }

    const counts = {};

    for (const restaurant of restaurants) {
        counts[restaurant.Cuisine] =
            (counts[restaurant.Cuisine] || 0) + 1;
    }

    console.table(counts);

    const batchSize = 100;

    for (
        let i = 0;
        i < restaurants.length;
        i += batchSize
    ) {
        await uploadBatch(
            restaurants.slice(i, i + batchSize)
        );

        console.log(
            `Indexed ${Math.min(i + batchSize, restaurants.length)}` +
            `/${restaurants.length}`
        );
    }

    await search.indices.refresh({ index: INDEX });

    const count = await search.count({
        index: INDEX
    });

    console.log(
        `OpenSearch index count: ${count.body.count}`
    );

    if (count.body.count < 1000) {
        throw new Error(
            "Index has fewer than 1,000 documents"
        );
    }

    console.log("Section 6 indexing completed!");
}

main().catch(error => {
    console.error(
        "OpenSearch import failed:",
        error.message
    );

    process.exitCode = 1;
});
