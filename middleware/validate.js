// ============================================================
//  middleware/validate.js  —  express-validator error handler
// ============================================================
//  Reads the result of express-validator checks run before
//  this middleware and returns a 422 if any field is invalid.
//
//  Usage in a route:
//    const { validate } = require('../middleware/validate');
//    router.post('/register', [body('email').isEmail()], validate, handler);
// ============================================================

const { validationResult } = require('express-validator');

/**
 * Reads express-validator errors from the request.
 * If any exist, responds immediately with 422 + the first error message.
 * Otherwise calls next() to continue to the route handler.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    // Return only the first error to keep responses clean
    const firstError = errors.array({ onlyFirstError: true })[0];
    return res.status(422).json({
      success: false,
      message: firstError.msg,
      field:   firstError.path || firstError.param, // express-validator v7 uses .path
    });
  }

  next();
};

module.exports = { validate };
