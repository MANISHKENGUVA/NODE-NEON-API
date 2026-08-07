const express = require("express");
const { sql } = require("../config/db");
const workflowRoutes = require("./workflow");
const { navigatorHandler } = require("./workflow");

const router = express.Router();

router.use("/workflow", workflowRoutes);
router.post("/workflow-navigator", navigatorHandler);

router.get("/health", async (req, res, next) => {
  try {
    await sql`SELECT 1 AS ok`;
    res.json({ success: true, message: "API and database are healthy" });
  } catch (err) {
    next(err);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    const users = await sql`SELECT id, name, email, created_at FROM users ORDER BY id`;
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
});

router.post("/users", async (req, res, next) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "name and email are required",
      });
    }

    const [user] = await sql`
      INSERT INTO users (name, email)
      VALUES (${name}, ${email})
      RETURNING id, name, email, created_at
    `;

    res.status(201).json({ success: true, data: user });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }
    next(err);
  }
});

module.exports = router;
