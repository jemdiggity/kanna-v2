# Physical-device mobile uninstall E2E gap

`./kd mobile uninstall --device` crosses the kd CLI, task runtime, Xcode's
CoreDevice tooling, and a physical iPhone. A faithful E2E test must attach an
isolated test device, install a disposable app under the exact target bundle
identifier, invoke the command, and verify that only that app disappeared.
The repository's automated environments do not provide a physical iPhone or a
safe disposable signing identity. This implementation task also explicitly
forbids operating on the incident device, so the new command was not invoked
against a phone.

A true E2E becomes feasible when a dedicated physical-device CI lane can:

- reserve a device exclusively by UDID;
- install disposable staging and production fixtures with separate local data;
- expose CoreDevice through the same Xcode version used by developers; and
- restore the device to a known state after both success and failure cases.

The narrower automated coverage added meanwhile exercises every safety
boundary without performing a device mutation:

- CLI parser tests require `--device`, exactly one environment, and the bundle
  confirmation token;
- runtime command tests pin the `devicectl` inspection and single-bundle
  uninstall argument vectors and exact bundle matching;
- task executor tests cover staging success with pre-mutation target output,
  an absent staging app, wrong confirmation, missing/ambiguous environment,
  multiple attached devices, production's additional confirmation guard, and
  CoreDevice command failure;
- the staging success test begins with both staging and production in the
  simulated installed-app list and proves that the only uninstall invocation
  names `build.kanna.app.staging`.
