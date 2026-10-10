import {LexRuntimeV2Client, RecognizeTextCommand} from "@aws-sdk/client-lex-runtime-v2";
import { randomUUID } from "node:crypto";

const lex = new LexRuntimeV2Client({});

const BOT_ID = process.env.LEX_BOT_ID;
const ALIAS_ID = process.env.LEX_BOT_ALIAS_ID;
const LOCALE_ID = process.env.LEX_LOCALE_ID || "en_US";

const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS"
};

function apiResponse(statusCode, body) {
    return {
        statusCode,
        headers,
        body: JSON.stringify(body)
    };
}

export const handler = async (event) => {
    try {
        let body = event.body ?? {};

        if (typeof body === "string") {
            body = JSON.parse(body);
        }

        const messages = body?.messages;

        if (!Array.isArray(messages) || messages.length === 0) {
            return apiResponse(400, {
                code: 400,
                message: "messages must be a non-empty array"
            });
        }

        const input = messages[0];

        if (
            input?.type !== "unstructured" ||
            typeof input?.unstructured?.text !== "string" ||
            !input.unstructured.text.trim()
        ) {
            return apiResponse(400, {
                code: 400,
                message: "Invalid message format"
            });
        }

        const userMessage = input.unstructured.text.trim();

        if (userMessage.length > 1024) {
            return apiResponse(400, {
                code: 400,
                message: "Message exceeds 1024 characters"
            });
        }

        const sessionId =
            typeof input.unstructured.id === "string" &&
            /^[a-zA-Z0-9._:-]{2,100}$/.test(input.unstructured.id)
                ? input.unstructured.id
                : randomUUID();

        const command = new RecognizeTextCommand({
            botId: BOT_ID,
            botAliasId: ALIAS_ID,
            localeId: LOCALE_ID,
            sessionId,
            text: userMessage
        });

        const lexResponse = await lex.send(command);

        const responseMessages = (
            lexResponse.messages || []
        )
            .filter(
                msg =>
                    msg.contentType === "PlainText" &&
                    typeof msg.content === "string"
            )
            .map(msg => ({
                type: "unstructured",
                unstructured: {
                    id: sessionId,
                    text: msg.content,
                    timestamp: new Date().toISOString()
                }
            }));

        if (responseMessages.length === 0) {
            responseMessages.push({
                type: "unstructured",
                unstructured: {
                    id: sessionId,
                    text: "Sorry, I couldn't understand that. Could you try again?",
                    timestamp: new Date().toISOString()
                }
            });
        }

        return apiResponse(200, {
            messages: responseMessages
        });

    } catch (error) {
        console.error("LF0 error:", {
            name: error.name,
            message: error.message
        });

        return apiResponse(500, {
            code: 500,
            message: "Chatbot service unavailable"
        });
    }
};
