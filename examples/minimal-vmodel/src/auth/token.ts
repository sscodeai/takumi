/**
 * JWT の発行・検証（基本設計書 2.2: トークン方式 JWT）
 */

import jwt from 'jsonwebtoken';
import type { AuthClaims } from '../domain/types.ts';

export interface TokenService {
  sign(claims: AuthClaims): string;
  verify(token: string): AuthClaims;
}

export function createTokenService(secret: string, expiresIn: string): TokenService {
  return {
    sign(claims: AuthClaims): string {
      return jwt.sign(claims, secret, {
        expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
      });
    },
    verify(token: string): AuthClaims {
      const decoded = jwt.verify(token, secret);
      if (typeof decoded === 'string' || decoded.sub === undefined) {
        throw new jwt.JsonWebTokenError('invalid token payload');
      }
      return {
        sub: Number(decoded.sub),
        username: String(decoded.username),
        role: decoded.role as AuthClaims['role'],
      };
    },
  };
}
