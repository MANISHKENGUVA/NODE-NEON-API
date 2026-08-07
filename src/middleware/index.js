const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const express = require("express");
const { context } = require("../context");

function applyMiddleware(app) {
  // Initialize AsyncLocalStorage store for every request so setContextKey/getContextKey work
  app.use((req, res, next) => {
    context.run({}, next);
  });

  app.use(cors({ origin: "*" }));
  app.use(helmet());
  app.use(morgan("dev"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
}

module.exports = { applyMiddleware };

