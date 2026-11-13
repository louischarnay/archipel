import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { AccessController } from './access.controller.js';
import { AccountController } from './account.controller.js';
import { AgentController } from './agent.controller.js';

@Module({
  imports: [RuntimeModule],
  controllers: [AccountController, AccessController, AgentController],
})
export class AccountModule {}
