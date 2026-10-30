#!/usr/bin/env node
process.stderr.write(
  'icloneos: this unscoped package is a name placeholder and does nothing.\n' +
    'Install the real launcher with:  npm uninstall -g icloneos && npm install -g @icloneos/cli\n',
);
process.exitCode = 1;
