import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  insertSession,
  findSession,
  removeSession,
  removeUserSessions,
  purgeExpiredSessions
} from './db.js';

const scryptAsync = promisify(crypto.scrypt);

// ===================================================
// SECURE PASSWORD HASHING (Asynchronous crypto.scrypt)
// ===================================================

/**
 * Hashes a plaintext password asynchronously using Node's crypto.scrypt.
 * Generates a unique 16-byte random salt per user.
 * @param {string} password 
 * @returns {Promise<{ hash: string, salt: string }>}
 */
export async function hashPassword(password) {
  if (!password || typeof password !== 'string' || password.length < 15 || password.length > 256) {
    throw new Error('Password must be between 15 and 256 characters long');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(password, salt, 64);
  return {
    hash: derivedKey.toString('hex'),
    salt
  };
}

/**
 * Verifies a password against a stored hash and salt asynchronously.
 * Uses timingSafeEqual to protect against side-channel timing attacks.
 * @param {string} password 
 * @param {string} salt 
 * @param {string} storedHash 
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;

  try {
    const derivedKey = await scryptAsync(password, salt, 64);
    const keyBuffer = Buffer.from(derivedKey.toString('hex'), 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (keyBuffer.length !== storedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(keyBuffer, storedBuffer);
  } catch (err) {
    console.error('Password verification error:', err.message);
    return false;
  }
}

// ===================================================
// CRYPTOGRAPHIC SESSIONS & CSRF TOKENS
// ===================================================

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Creates a new session with cryptographically secure session and CSRF tokens.
 * Persists session directly in SQLite.
 * @param {number} userId 
 * @returns {{ sessionId: string, csrfToken: string, expiresAt: number }}
 */
export function createSession(userId) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;

  insertSession(sessionId, userId, csrfToken, expiresAt);
  return { sessionId, csrfToken, expiresAt };
}

/**
 * Deletes a single session (e.g. on logout or invalidation).
 * @param {string} sessionId 
 */
export function destroySession(sessionId) {
  if (sessionId) {
    removeSession(sessionId);
  }
}

/**
 * Revokes all active sessions for a given user.
 * @param {number} userId 
 */
export function destroyAllUserSessions(userId) {
  if (userId) {
    removeUserSessions(userId);
  }
}

// ===================================================
// COOKIE HELPERS
// ===================================================

/**
 * Parses the Cookie header into a key-value object.
 * @param {string} [header] 
 * @returns {Record<string, string>}
 */
export function parseCookies(header = '') {
  const cookies = {};
  if (!header || typeof header !== 'string') return cookies;

  const pairs = header.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

/**
 * Attaches standard cookie parsing middleware to express request.
 */
export function cookieParserMiddleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie || '');
  next();
}

/**
 * Sets session and CSRF cookies on the response.
 * Follows security best practices: HttpOnly for sid, SameSite=Lax, and Secure in production.
 */
export function setSessionCookies(res, sessionId, csrfToken) {
  const isProduction = process.env.NODE_ENV === 'production';

  // Server-side session ID (HttpOnly prevents XSS cookie theft)
  res.cookie('mediavault_sid', sessionId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });

  // CSRF token readable by client JS to include in custom x-csrf-token header
  res.cookie('mediavault_csrf', csrfToken, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

/**
 * Clears session cookies on logout or session invalidation.
 */
export function clearSessionCookies(res) {
  const isProduction = process.env.NODE_ENV === 'production';
  const opts = {
    secure: isProduction,
    sameSite: 'lax',
    path: '/'
  };

  res.clearCookie('mediavault_sid', { ...opts, httpOnly: true });
  res.clearCookie('mediavault_csrf', { ...opts, httpOnly: false });
}

// ===================================================
// AUTHENTICATION MIDDLEWARES
// ===================================================

/**
 * Middleware: Requires a valid logged-in session.
 * Rejects unauthenticated requests with HTTP 401.
 */
export function requireAuth(req, res, next) {
  const sessionId = req.cookies?.mediavault_sid;

  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  const session = findSession(sessionId);
  if (!session) {
    clearSessionCookies(res);
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }

  // Check expiration
  if (session.expires_at < Date.now()) {
    destroySession(sessionId);
    clearSessionCookies(res);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  req.user = {
    id: session.user_id,
    username: session.username
  };
  req.session = session;

  next();
}

/**
 * Middleware: Attaches user info if a session is present, but does not block.
 */
export function optionalAuth(req, res, next) {
  const sessionId = req.cookies?.mediavault_sid;
  if (!sessionId) {
    req.user = null;
    return next();
  }

  const session = findSession(sessionId);
  if (session && session.expires_at >= Date.now()) {
    req.user = {
      id: session.user_id,
      username: session.username
    };
    req.session = session;
  } else {
    req.user = null;
  }

  next();
}

// ===================================================
// CSRF PROTECTION MIDDLEWARE
// ===================================================

/**
 * Middleware: Validates CSRF token on all state-changing requests (POST, PUT, DELETE, PATCH).
 * Protects against Cross-Site Request Forgery attacks.
 */
export function csrfProtection(req, res, next) {
  // Safe methods do not require CSRF token
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method.toUpperCase())) {
    return next();
  }

  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.mediavault_csrf;

  if (!headerToken) {
    return res.status(403).json({ error: 'Missing CSRF token in request headers.' });
  }

  // Verify header token matches cookie token
  if (!cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }

  // If user is authenticated, ensure it also matches their session's stored CSRF token
  if (req.session?.csrf_token && headerToken !== req.session.csrf_token) {
    return res.status(403).json({ error: 'CSRF token mismatch with active session.' });
  }

  next();
}

// ===================================================
// RATE LIMITING (In-Memory Sliding Window)
// ===================================================

/**
 * Factory for sliding-window rate limiters.
 * Keyed by an identifier extracted from the request (e.g. IP or user_id).
 */
export function createRateLimiter({ windowMs, maxRequests, message, keyGenerator }) {
  const records = new Map(); // key -> { count: number, resetTime: number }

  // Periodic memory cleanup every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [k, rec] of records.entries()) {
      if (now > rec.resetTime) {
        records.delete(k);
      }
    }
  }, 5 * 60 * 1000).unref();

  return (req, res, next) => {
    const key = keyGenerator ? keyGenerator(req) : (req.ip || req.socket.remoteAddress || 'anonymous');
    const now = Date.now();

    let rec = records.get(key);
    if (!rec || now > rec.resetTime) {
      rec = { count: 1, resetTime: now + windowMs };
      records.set(key, rec);
      return next();
    }

    if (rec.count >= maxRequests) {
      const retryAfterSec = Math.ceil((rec.resetTime - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: message || `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`
      });
    }

    rec.count += 1;
    next();
  };
}

// Rate limiter for authentication attempts (Login / Register): Max 10 attempts per 5 minutes per IP
export const authLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many authentication attempts. Please wait 5 minutes before trying again.',
  keyGenerator: (req) => `${req.ip || 'ip'}_auth`
});

// Rate limiter for AI requests: Max 5 requests per 10 minutes per logged-in user
export const aiLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 5,
  message: 'AI request limit reached (max 5 per 10 minutes). Please wait a few minutes before requesting more suggestions.',
  keyGenerator: (req) => (req.user?.id ? `user_${req.user.id}_ai` : `${req.ip || 'ip'}_ai`)
});

// Rate limiter for password change attempts: Max 5 attempts per 5 minutes per user/IP
export const passwordChangeLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 5,
  message: 'Too many password change attempts. Please wait 5 minutes before trying again.',
  keyGenerator: (req) => (req.user?.id ? `user_${req.user.id}_pwd` : `${req.ip || 'ip'}_pwd`)
});

