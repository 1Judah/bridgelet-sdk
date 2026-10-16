import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SweepsService } from './sweeps.service.js';
import { ValidationProvider } from './providers/validation.provider.js';
import { ContractProvider } from './providers/contract.provider.js';
import { TransactionProvider } from './providers/transaction.provider.js';
import { SweepMetricsProvider } from './providers/sweep-metrics.provider.js';
import { Account } from '../accounts/entities/account.entity.js';
import { StellarModule } from '../stellar/stellar.module.js';
import { makeCounterProvider } from '@willsoto/nestjs-prometheus';

const sweepSuccessCounter = makeCounterProvider({
  name: 'sweep_success_total',
  help: 'Total number of successful sweeps',
});
const sweepFailureCounter = makeCounterProvider({
  name: 'sweep_failure_total',
  help: 'Total number of failed sweeps',
});

/**
 * #650: every provider below is registered with Nest's default scope, i.e.
 * a singleton instantiated once for the application, not per request. None
 * of them declares `scope: Scope.REQUEST`, and none may: `ContractProvider`
 * and `TransactionProvider` each open a Stellar network connection in their
 * constructor, so request-scoped instantiation would rebuild those
 * connections on every call and add latency under load.
 *
 * If a provider here ever needs request-scoped state, hold that state in the
 * method arguments rather than changing the provider's scope.
 *
 * Verified for #711 (duplicate of the already-resolved #650, fixed in PR #781):
 * no provider declares `Scope.REQUEST`, so the instances above - and the
 * Stellar connections they open in their constructors - are created once per
 * process rather than once per request.
 *
 * Verified for #864: `ContractProvider` and `TransactionProvider` are each
 * registered once in the `providers` array below with no `scope` override,
 * so Nest instantiates a single singleton of each per application lifecycle.
 * Neither is request-scoped, and neither is instantiated per request.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Account]), StellarModule],
  providers: [
    SweepsService,
    ValidationProvider,
    ContractProvider,
    TransactionProvider,
    SweepMetricsProvider,
    sweepSuccessCounter,
    sweepFailureCounter,
  ],
  exports: [SweepsService],
})
export class SweepsModule {}
