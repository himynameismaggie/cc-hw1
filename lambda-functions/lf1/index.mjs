import {SQSClient, SendMessageCommand} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL;
const SUPPORTED_CUISINES = new Set([
    "chinese",
    "japanese",
    "italian",
    "indian",
    "mexican"
]);

function getSlot(slots, name) {
    return slots?.[name]?.value?.interpretedValue ?? null;
}

function reply(intent, message, state = "Fulfilled") {
    return {
        sessionState: {
            dialogAction: { type: "Close" },
            intent: {
                ...intent,
                state
            }
        },
        messages: [{
            contentType: "PlainText",
            content: message
        }]
    };
}

function delegate(event) {
    return {
        sessionState: {
            ...event.sessionState,
            dialogAction: { type: "Delegate" }
        }
    };
}

function elicitSlot(event, slotName, message) {
    const intent = event.sessionState.intent;

    return {
        sessionState: {
            ...event.sessionState,
            dialogAction: {
                type: "ElicitSlot",
                slotToElicit: slotName
            },
            intent: {
                ...intent,
                state: "InProgress"
            }
        },
        messages: [{
            contentType: "PlainText",
            content: message
        }]
    };
}

function validateDining(event) {
    const slots = event.sessionState.intent.slots ?? {};

    const location = getSlot(slots, "Location");
    const cuisine = getSlot(slots, "Cuisine");
    const partySize = getSlot(slots, "PartySize");
    const date = getSlot(slots, "DiningDate");
    const time = getSlot(slots, "DiningTime");
    const email = getSlot(slots, "Email");

    if (location && !/^(manhattan|new york|new york city|nyc)$/i.test(
        location.trim()
    )) {
        slots.Location = null;
        return elicitSlot(
            event,
            "Location",
            "I currently support Manhattan only. Please enter Manhattan."
        );
    }

    if (cuisine && !SUPPORTED_CUISINES.has(cuisine.toLowerCase())) {
        slots.Cuisine = null;
        return elicitSlot(
            event,
            "Cuisine",
            "Please choose Chinese, Japanese, Italian, Indian, or Mexican."
        );
    }

    if (partySize && (
        !Number.isInteger(Number(partySize)) ||
        Number(partySize) < 1 ||
        Number(partySize) > 20
    )) {
        slots.PartySize = null;
        return elicitSlot(
            event,
            "PartySize",
            "Please enter a party size between 1 and 20."
        );
    }

    if (date && time) {
        const diningDateTime = new Date(
            `${date}T${time.length === 5 ? time + ":00" : time}-04:00`
        );
        if (Number.isNaN(diningDateTime.getTime())) {
            slots.DiningTime = null;
            return elicitSlot(event, "DiningTime", "Please enter a valid time.");
        }
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        slots.Email = null;
        return elicitSlot(
            event,
            "Email",
            "That email doesn't look valid. Please enter it again."
        );
    }

    return null;
}

async function handleDining(event) {
    const intent = event.sessionState.intent;

    if (event.invocationSource === "DialogCodeHook") {
        const validation = validateDining(event);
        return validation ?? delegate(event);
    }

    if (event.invocationSource !== "FulfillmentCodeHook") {
        return delegate(event);
    }

    const validation = validateDining(event);
    if (validation) return validation;

    const slots = intent.slots ?? {};

    const request = {
        requestId: randomUUID(),
        sessionId: event.sessionId,
        location: getSlot(slots, "Location"),
        cuisine: getSlot(slots, "Cuisine"),
        partySize: Number(getSlot(slots, "PartySize")),
        diningDate: getSlot(slots, "DiningDate"),
        diningTime: getSlot(slots, "DiningTime"),
        email: getSlot(slots, "Email"),
        requestedAt: new Date().toISOString()
    };

    if (
        !request.location ||
        !request.cuisine ||
        !request.diningDate ||
        !request.diningTime ||
        !request.email ||
        !Number.isInteger(request.partySize) ||
        request.partySize < 1
    ) {
        return reply(
            intent,
            "Some dining details are missing. Please start your request again.",
            "Failed"
        );
    }

    try {
        await sqs.send(new SendMessageCommand({
            QueueUrl: QUEUE_URL,
            MessageBody: JSON.stringify(request)
        }));

        console.log("Dining request queued", request.requestId);

        return reply(
            intent,
            "You're all set! I've received your dining request. " +
            "I'll email you restaurant suggestions shortly."
        );

    } catch (error) {
        console.error("Failed to enqueue dining request", error);

        return reply(
            intent,
            "Sorry, I couldn't submit your request. Please try again.",
            "Failed"
        );
    }
}

export const handler = async (event) => {
    const intent = event.sessionState?.intent;
    const name = intent?.name;

    console.log("Intent:", name);
    console.log("Invocation:", event.invocationSource);

    switch (name) {
        case "GreetingIntent":
            return reply(
                intent,
                "Hi there! How can I help you find a restaurant?"
            );

        case "ThankYouIntent":
            return reply(
                intent,
                "You're welcome! Enjoy your meal."
            );

        case "DiningSuggestionsIntent":
            return await handleDining(event);

        default:
            return reply(
                intent ?? { name: "FallbackIntent" },
                "Sorry, I didn't understand that.",
                "Failed"
            );
    }
};
