import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { loadEnv } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { LdapService } from './ldap.service';
import { PasswordService } from './password.service';

@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: loadEnv().JWT_SECRET }) })],
  controllers: [AuthController],
  providers: [
    AuthService, PasswordService, LdapService,
    { provide: APP_GUARD, useClass: AuthGuard },   // ყველა endpoint დახურულია ნაგულისხმევად
  ],
  exports: [PasswordService],
})
export class AuthModule {}
