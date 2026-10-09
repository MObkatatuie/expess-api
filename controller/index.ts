import express from "express";

export const router = express.Router();

// GET /  -> รายการ endpoint ทั้งหมดของ API
router.get("/", (_req, res) => {
  res.json({
    name: "HW-5 Web API",
    endpoints: [
      "/api/customers",
      "/api/customers/search?q=",
      "/api/customers/nearby?lat=&lng=",
      "/api/orders",
      "/api/orders/mock",
      "/api/orders/nearby?lat=&lng=",
      "/api/orders/:id/boxes",
      "DELETE /api/orders/real",
      "POST /api/dispatch/plans?count=3",
      "POST /api/dispatch/confirm",
      "GET /api/dispatch/current",
      "DELETE /api/dispatch/current",
      "GET /api/jobs/:job_code",
    ],
  });
});
