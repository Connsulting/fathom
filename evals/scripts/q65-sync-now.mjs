export async function script() {
  return [
    { toolCalls: [{ name: 'refresh', args: { operation: 'run_job', job: 'simplefin-sync', propose: true } }], costUsd: 0 },
    { text: 'Run the bank sync now? Confirm below.', costUsd: 0 },
  ];
}
