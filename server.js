// Core of what it does:
require('dotenv').config();
const express = require('express');
const axios = require('axios');
// ...

app.post('/api/shopify/webhook/orders', async (req, res) => {
  // 1. Verifies Shopify HMAC (so only real orders trigger)
  // 2. Gets Sellvia WON-xxx order ID
  // 3. Calls Sellvia API: POST /orders/{id}/approve
  // This fixes your 3 stuck ~$29.97 orders
});

app.get('/api/sellvia/auto-approve', async (req, res) => {
  // Manual button to approve all pending: WON-4YSPJ0BXFVJY, WON-YL9L6JOTCWG7, WON-HPSCSL5L81ME
});

app.get('/api/payouts/status', (req, res) => {
  // Returns dashboard fluff vs actually withdrawable
  // $142.87 / $122.87 / 714% vs Available for Withdrawal in Finances
});

app.get('/dashboard', (req, res) => {
  // Visual dashboard at /dashboard?shop=wonderful-gems-point.myshopify.com&sellvia=connected
});
