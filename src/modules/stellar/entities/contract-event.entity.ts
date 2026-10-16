import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Indexed Soroban contract events.
 *
 * Append-only and unbounded: rows are only ever inserted, never updated, so the
 * table grows for as long as the contract emits events. Indexes are therefore
 * chosen for read patterns while keeping insert amplification in mind (#653).
 * See docs/database-schema.md for the index rationale and the retention /
 * partitioning strategy this table will need before it gets large.
 *
 * Note: no code queries this table yet. The indexes below follow the documented
 * access patterns (by contract, by event type, by ledger, by transaction); once
 * a real consumer exists, re-validate them with EXPLAIN ANALYZE and drop
 * whichever earns nothing.
 *
 * Verified for #714 (duplicate of the already-resolved #653, fixed in PR #778):
 * docs/database-schema.md records the rationale for each index plus the
 * retention/partitioning plan this append-only table will need.
 *
 * Re-verified for #867 (duplicate of #714/#653): every column the ingestion
 * read paths touch is indexed by migration
 * 1718100009000-AddContractEventIndexes — (contract_address, ledger_sequence),
 * (event_type, ledger_sequence), ledger_sequence and tx_hash — so high-volume
 * ingestion is not served by a sequential scan.
 */
@Index('IDX_contract_events_contract_address_ledger_sequence', [
  'contractAddress',
  'ledgerSequence',
])
@Index('IDX_contract_events_event_type_ledger_sequence', [
  'eventType',
  'ledgerSequence',
])
@Index('IDX_contract_events_ledger_sequence', ['ledgerSequence'])
@Index('IDX_contract_events_tx_hash', ['txHash'])
@Entity('contract_events')
export class ContractEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'event_type', type: 'varchar', length: 255 })
  eventType: string;

  @Column({ name: 'contract_address', type: 'varchar', length: 128 })
  contractAddress: string;

  @Column({ name: 'ledger_sequence', type: 'bigint' })
  ledgerSequence: string;

  @Column({ name: 'tx_hash', type: 'varchar', length: 64 })
  txHash: string;

  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
