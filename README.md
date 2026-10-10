# Refund Request Flow

This application includes a simple refund request flow for customer support and order issues.

## What it does

- Provides a refund request form at `/refund-request`
- Accepts refund submissions via `/api/refund/request`
- Stores each request in the SQLite database
- Generates a prefilled email draft for `papoosedaniels94@gmail.com`
- Lets staff review submissions via `/api/refund/requests`

## Routes

### Public refund form

`GET /refund-request`

Optional query parameters:
- `orderId`
- `customerEmail`

Example:

`/refund-request?orderId=12345&customerEmail=customer@example.com`

### Refund API

`POST /api/refund/request`

Request body:

```json
{
  "orderId": "12345",
  "customerEmail": "customer@example.com",
  "reason": "Product not as described",
  "message": "Please review this order and confirm the refund status."
}
```

Response:

```json
{
  "message": "Refund request received",
  "id": 1,
  "status": "submitted",
  "emailDraft": {
    "to": "papoosedaniels94@gmail.com",
    "subject": "Refund request for order #12345",
    "body": "Hello, ..."
  }
}
```

### Admin list

`GET /api/refund/requests`

Required header:

```http
X-Admin-Token: YOUR_ADMIN_TOKEN
```

## Database

The app stores refund records in the `refund_requests` table.

Fields:
- `id`
- `order_id`
- `customer_email`
- `reason`
- `message`
- `status`
- `created_at`

## Email behavior

The app generates a `mailto:` draft that opens the customer’s email app with the refund email prefilled and addressed to:

`papoosedaniels94@gmail.com`

This is the correct workflow if you are using a browser-based refund interface and are not sending emails directly from the server.

## Local usage

```bash
npm install
npm start
```

Then visit:

```text
http://localhost:3000/refund-request
```
