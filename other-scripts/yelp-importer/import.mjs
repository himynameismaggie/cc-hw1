import "dotenv/config";

import {
    DynamoDBClient
} from "@aws-sdk/client-dynamodb";

import {
    DynamoDBDocumentClient,
    BatchWriteCommand
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.DYNAMODB_TABLE || "yelp-restaurants";
const API_KEY = process.env.YELP_API_KEY;

if (!API_KEY) {
    throw new Error("Missing YELP_API_KEY");
}

const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION })
);

const CUISINES = {
    Chinese: "chinese",
    Japanese: "japanese",
    Italian: "italian",
    Indian: "indpak",
    Mexican: "mexican"
};

const NEIGHBORHOODS = [
    "Chinatown, Manhattan, NY",
    "Lower East Side, Manhattan, NY",
    "East Village, Manhattan, NY",
    "West Village, Manhattan, NY",
    "SoHo, Manhattan, NY",
    "Chelsea, Manhattan, NY",
    "Midtown Manhattan, NY",
    "Hell's Kitchen, Manhattan, NY",
    "Upper East Side, Manhattan, NY",
    "Upper West Side, Manhattan, NY",
    "Harlem, Manhattan, NY",
    "Washington Heights, Manhattan, NY"
];

const TARGET_PER_CUISINE = 200;
const PAGE_SIZE = 50;
const MAX_OFFSET = 200;
const DELAY_MS = 300;

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

async function searchYelp(cuisineAlias, location, offset) {
    const url = new URL(
        "https://api.yelp.com/v3/businesses/search"
    );

    url.searchParams.set("location", location);
    url.searchParams.set("categories", cuisineAlias);
    url.searchParams.set("limit", PAGE_SIZE);
    url.searchParams.set("offset", offset);
    url.searchParams.set("sort_by", "best_match");

    let attempt = 0;

    while (attempt < 5) {
        attempt++;

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                Accept: "application/json"
            },
            signal: AbortSignal.timeout(15000)
        });

        if (response.ok) {
            return await response.json();
        }

        if (
            (response.status === 429 || response.status >= 500)
            && attempt < 5
        ) {
            const retryAfter = Number(
                response.headers.get("retry-after")
            );

            const waitMs =
                Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000
                    : 1000 * 2 ** attempt;

            console.warn(
                `Yelp HTTP ${response.status}; retrying in ${waitMs}ms`
            );

            await sleep(waitMs);
            continue;
        }

        throw new Error(
            `Yelp API returned ${response.status}: ` +
            (await response.text()).slice(0, 300)
        );
    }
}

function isManhattan(business) {
    const location = business.location || {};
    const zip = location.zip_code || "";
    const coords = business.coordinates || {};

    const zipValid = /^(100|101|102)\d{2}$/.test(zip);

    const lat = coords.latitude;
    const lon = coords.longitude;

    const coordinateValid =
        typeof lat === "number" &&
        typeof lon === "number" &&
        lat >= 40.69 && lat <= 40.89 &&
        lon >= -74.04 && lon <= -73.90;

    return (
        location.city?.toLowerCase() === "new york" &&
        location.state === "NY" &&
        zipValid &&
        coordinateValid
    );
}

function normalizeRestaurant(business, cuisine) {
    if (!business.id || !business.name) return null;
    if (!isManhattan(business)) return null;

    const location = business.location;
    const coordinates = business.coordinates;

    if (
        !location.address1 ||
        !location.zip_code ||
        typeof coordinates.latitude !== "number" ||
        typeof coordinates.longitude !== "number" ||
        typeof business.rating !== "number" ||
        typeof business.review_count !== "number"
    ) {
        return null;
    }

    return {
        businessId: business.id,
        name: business.name,
        cuisine,
        address: location.display_address?.join(", ")
            || location.address1,
        coordinates: {
            latitude: coordinates.latitude,
            longitude: coordinates.longitude
        },
        reviewCount: business.review_count,
        rating: business.rating,
        zipCode: location.zip_code,
        insertedAtTimestamp: new Date().toISOString()
    };
}

async function collectRestaurants() {
    const allRestaurants = new Map();
    const counts = {};

    for (const [cuisine, alias] of Object.entries(CUISINES)) {
        console.log(`\nCollecting ${cuisine} restaurants...`);

        let added = 0;

        for (const neighborhood of NEIGHBORHOODS) {
            if (added >= TARGET_PER_CUISINE) break;

            for (
                let offset = 0;
                offset < MAX_OFFSET;
                offset += PAGE_SIZE
            ) {
                if (added >= TARGET_PER_CUISINE) break;

                const result = await searchYelp(
                    alias,
                    neighborhood,
                    offset
                );

                const businesses = result.businesses || [];

                if (businesses.length === 0) break;

                // Randomize selection within each result page.
                for (let i = businesses.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [businesses[i], businesses[j]] =
                        [businesses[j], businesses[i]];
                }

                for (const business of businesses) {
                    if (added >= TARGET_PER_CUISINE) break;
                    if (allRestaurants.has(business.id)) continue;

                    const restaurant = normalizeRestaurant(
                        business,
                        cuisine
                    );

                    if (!restaurant) continue;

                    allRestaurants.set(business.id, restaurant);
                    added++;
                }

                console.log(
                    `${cuisine} | ${neighborhood} | ` +
                    `offset ${offset} | collected ${added}`
                );

                await sleep(DELAY_MS);

                if (businesses.length < PAGE_SIZE) break;
            }
        }

        counts[cuisine] = added;
        console.log(`${cuisine}: ${added} unique restaurants`);
    }

    console.table(counts);
    console.log("Total unique:", allRestaurants.size);

    return [...allRestaurants.values()];
}

async function writeBatch(items) {
    let requests = items.map(item => ({
        PutRequest: { Item: item }
    }));

    for (let attempt = 0; attempt < 8; attempt++) {
        const result = await client.send(
            new BatchWriteCommand({
                RequestItems: {
                    [TABLE]: requests
                }
            })
        );

        requests = result.UnprocessedItems?.[TABLE] || [];

        if (requests.length === 0) return;

        await sleep(
            Math.min(1000 * 2 ** attempt, 10000)
        );
    }

    throw new Error(
        `${requests.length} DynamoDB writes remain unprocessed`
    );
}

async function main() {
    const restaurants = await collectRestaurants();

    if (restaurants.length < 1000) {
        console.warn(
            `Only ${restaurants.length} restaurants collected. ` +
            "Target not met; no database writes performed."
        );
        process.exitCode = 1;
        return;
    }

    console.log("\nUploading restaurants to DynamoDB...");

    for (let i = 0; i < restaurants.length; i += 25) {
        const batch = restaurants.slice(i, i + 25);

        await writeBatch(batch);

        console.log(
            `Uploaded ${Math.min(i + 25, restaurants.length)}` +
            `/${restaurants.length}`
        );
    }

    console.log("\nImport complete!");
}

main().catch(error => {
    console.error("Import failed:", error.message);
    process.exitCode = 1;
});
