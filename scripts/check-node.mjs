const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 18) {
  console.error(
    `NextStop requires Node >=24.18.0 <25; found ${process.version}. Use Node 24 (.nvmrc).`,
  );
  process.exitCode = 1;
}
