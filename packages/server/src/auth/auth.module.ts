import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './access.js';
import { AuthController } from './auth.controller.js';
import { AuthCookies } from './cookies.js';
import { Oidc } from './oidc.js';
import { Sessions } from './sessions.js';
import { Setup } from './setup.js';

// Identity comes from the provider; this module keeps the session, and checks who may call each route.
@Global()
@Module({
  controllers: [AuthController],
  providers: [Sessions, Setup, AuthCookies, Oidc, { provide: APP_GUARD, useClass: AccessGuard }],
  exports: [Sessions, Setup, AuthCookies, Oidc],
})
export class AuthModule {}
