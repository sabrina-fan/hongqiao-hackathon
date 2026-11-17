console.error('Langfuse dataset experiments are not connected yet. No model evaluation ran.');
console.error(
  'Implement the versioned datasets, gateway task runner, evaluators, and release thresholds before enabling this gate.',
);
if (process.argv.includes('--local')) {
  console.error(
    'Local image fixtures are available in testdata/xhs-suzhou; originals must not be uploaded to Langfuse.',
  );
}
process.exitCode = 1;
