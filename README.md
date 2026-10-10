# Dining Concierge Chatbot — Assignment 1

Cloud Computing and Big Data · Fall 2026

## Overview

Dining Concierge is a serverless restaurant recommendation application built on AWS. Users interact with a chatbot to specify their location, cuisine, party size, dining date and time, and email address. The application asynchronously sends restaurant recommendations by email.

## Architecture

S3 Website → API Gateway → Lambda LF0 → Amazon Lex V2 → Lambda LF1 → Amazon SQS → Lambda LF2 → OpenSearch + DynamoDB → Amazon SES

EventBridge Scheduler invokes LF2 every minute to process queued requests.

## Repository Structure

- `frontend/` — HTML, CSS, JavaScript, and API Gateway client SDK
- `lambda-functions/LF0/` — Chat API and Lex integration
- `lambda-functions/LF1/` — Lex code hook, slot validation, and SQS submission
- `lambda-functions/LF2/` — SQS queue worker, restaurant lookup, and email delivery
- `other-scripts/` — Restaurant data importer and OpenSearch indexing utilities
- `swagger/` — API specification

## AWS Services

- Amazon S3 — Static website hosting
- Amazon API Gateway — REST endpoint (`POST /chatbot`)
- AWS Lambda — LF0, LF1, LF2
- Amazon Lex V2 — Conversational interface
- Amazon SQS — Dining request queue
- Amazon DynamoDB — Restaurant data
- Amazon OpenSearch Service — Cuisine-based restaurant lookup
- Amazon SES — Recommendation emails
- Amazon EventBridge Scheduler — Periodic LF2 invocation
- Amazon CloudWatch — Logs and monitoring
- AWS IAM — Service permissions

## How the Application Works

1. The user opens the S3-hosted chatbot.
2. LF0 forwards messages to Amazon Lex.
3. Lex and LF1 collect and validate dining preferences.
4. LF1 publishes a request to Amazon SQS.
5. EventBridge invokes LF2 to process queued requests.
6. LF2 selects restaurants from OpenSearch and retrieves details from DynamoDB.
7. LF2 sends recommendations through Amazon SES.

## Deployment Notes

The frontend is hosted from the contents of `frontend/`. Lambda functions use Node.js ES Modules with `index.handler` as the handler.

External packages can be installed in each Lambda directory using `npm ci`, where a lockfile is provided.

The application requires environment-specific configuration for Lex, SQS, DynamoDB, OpenSearch, and SES. API keys and AWS credentials are intentionally excluded from this repository.

## Live Application

S3 website: http://dining-concierge-mgh3128.s3-website-us-east-1.amazonaws.com

## Demonstration

Demo video: [INSERT LINK IF APPLICABLE]