import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DoctorsController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({ imports: [AuthModule], controllers: [UsersController, DoctorsController], providers: [UsersService] })
export class UsersModule {}
