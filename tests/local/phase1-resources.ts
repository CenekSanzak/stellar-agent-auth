import { rpc, type Transaction, xdr } from '@stellar/stellar-sdk';
import { expect } from 'vitest';

const ids = xdr.ConfigSettingId;
const configIds = [
  ids.configSettingContractComputeV0,
  ids.configSettingContractBandwidthV0,
  ids.configSettingContractEventsV0,
  ids.configSettingContractLedgerCostV0,
  ids.configSettingContractLedgerCostExtV0,
  ids.configSettingContractDataEntrySizeBytes,
];

export async function resourceLimits(server: rpc.Server) {
  const response = await server.getLedgerEntries(...configIds.map((configSettingId) =>
    xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId })),
  ));
  const settings = response.entries.flatMap(({ val }) => val.type === 'configSetting' ? [val.configSetting] : []);
  function get<K extends xdr.ConfigSettingEntry['type']>(type: K): Extract<xdr.ConfigSettingEntry, { type: K }> {
    const setting = settings.find((item) => item.type === type);
    if (!setting) throw new Error(`Missing ledger config setting: ${type}`);
    return setting as Extract<xdr.ConfigSettingEntry, { type: K }>;
  }
  const ledger = get('configSettingContractLedgerCostV0').contractLedgerCost;
  return {
    instructions: Number(get('configSettingContractComputeV0').contractCompute.txMaxInstructions),
    txBytes: get('configSettingContractBandwidthV0').contractBandwidth.txMaxSizeBytes,
    eventBytes: get('configSettingContractEventsV0').contractEvents.txMaxContractEventsSizeBytes,
    diskReadBytes: ledger.txMaxDiskReadBytes,
    writeBytes: ledger.txMaxWriteBytes,
    writeEntries: ledger.txMaxWriteLedgerEntries,
    footprintEntries: get('configSettingContractLedgerCostExtV0').contractLedgerCostExt.txMaxFootprintEntries,
    entryBytes: get('configSettingContractDataEntrySizeBytes').contractDataEntrySizeBytes,
  };
}

export function assertResourceFit(
  label: string,
  simulation: rpc.Api.SimulateTransactionSuccessResponse,
  tx: Transaction,
  events: xdr.ContractEvent[],
  limits: Awaited<ReturnType<typeof resourceLimits>>,
) {
  const resources = simulation.transactionData.build().resources;
  const usage = {
    instructions: resources.instructions,
    txBytes: tx.toEnvelope().toXdr().length,
    eventBytes: events.reduce((sum, event) => sum + event.toXdr().length, 0),
    diskReadBytes: resources.diskReadBytes,
    writeBytes: resources.writeBytes,
    writeEntries: resources.footprint.readWrite.length,
    footprintEntries: resources.footprint.readOnly.length + resources.footprint.readWrite.length,
    entryBytes: Math.max(0, ...simulation.stateChanges?.map(({ after }) => after?.toXdr().length ?? 0) ?? []),
  };
  for (const key of Object.keys(usage) as (keyof typeof usage)[]) {
    expect(usage[key], `${label}: ${key}`).toBeLessThanOrEqual(limits[key]);
  }
  console.info(label, {
    ...usage,
    minResourceFeeStroops: simulation.minResourceFee,
    eventXdrBytes: events.map((event) => event.toXdr().length),
  });
}
