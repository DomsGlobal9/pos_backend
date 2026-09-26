import { Request, Response, NextFunction } from 'express';
import { isHttpError } from '../utils/httpError';

/**
 * The last thing every request passes through, and the reason a cashier never sees a stack trace.
 *
 * Two jobs, and the second is the important one:
 *
 *   1. An error thrown on purpose (utils/httpError) carries a sentence written for a person. Pass it
 *      through as it is.
 *   2. ANYTHING ELSE is a leak. A Prisma error names tables and columns; an axios error can carry a
 *      URL with a token in it; a TypeError names our own files. None of that goes over the counter.
 *      It is logged in full here and replaced with one plain sentence.
 *
 * The rule holds for streamed responses too. Inventory learned that its safe-message gate was
 * bypassed by anything writing to the response itself, so a route that has already started writing
 * must catch its own errors rather than relying on this.
 */
export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  if (isHttpError(err)) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.details ? { details: err.details } : {})
    });
  }

  // Everything that reaches here is unexpected, and worth the noise in the log: the method, the
  // path, and the whole error. Without the path, an error at a till is untraceable after the fact.
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  if (res.headersSent) {
    // Already writing. Ending the response is all that is left; a second set of headers would throw
    // inside the error handler itself.
    return res.end();
  }

  return res.status(err?.statusCode && err.statusCode < 500 ? err.statusCode : 500).json({
    success: false,
    message: 'Something went wrong at our end. Try once more -- if it happens again, nothing has been charged.'
  });
};

/** A path that does not exist. Worth its own sentence, because the usual cause is a till running an
 * older build against a newer server. */
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'That is not something this service can do. The till may need a refresh.',
    details: { path: req.originalUrl }
  });
};
