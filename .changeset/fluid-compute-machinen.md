---
"@federated-compute/machinen-plugin": minor
---

Add VM image/vmstate publishing support used by the fluid compute demo and harden MachineN snapshot/restore flows. Breaking (0.x minor): vmstate bundle manifests now require `compatibility.shell`, vmstate pulls require the `vmstateShell` option, and snapshot markers without a shell identity are refused at restore.
