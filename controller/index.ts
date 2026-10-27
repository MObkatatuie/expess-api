import express from "express";

export const router = express.Router();

const endpoints = [
  "GET /",
  "GET /api/customers",
  "POST /api/customers",
  "GET /api/customers/search?q=",
  "GET /api/customers/nearby?lat=&lng=",
  "GET /api/customers/:id",
  "PUT /api/customers/:id",
  "DELETE /api/customers/:id",
  "GET /api/orders",
  "POST /api/orders",
  "GET /api/orders/:id",
  "PUT /api/orders/:id",
  "DELETE /api/orders/:id",
  "POST /api/orders/mock",
  "DELETE /api/orders/mock",
  "DELETE /api/orders/real",
  "GET /api/orders/nearby?lat=&lng=",
  "POST /api/orders/:id/boxes",
  "DELETE /api/orders/:id/boxes",
  "POST /api/dispatch/plans?count=1",
  "POST /api/dispatch/confirm",
  "GET /api/dispatch/current",
  "DELETE /api/dispatch/current",
  "GET /api/jobs/:job_code",
];

// GET / -> List API endpoints, including this index.
router.get("/", (_req, res) => {
  res.json({
    name: "HW-5 Web API",
    total: endpoints.length,
    endpoints,
  });
});
