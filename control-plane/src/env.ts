import dotenv from "dotenv";

// Load .env before any other modules (db.ts / tenants.ts) read process.env
dotenv.config();
