# Cloud Functions public-invoker reconciliation E2E gap

## Gap

`./kd cloud deploy --functions` now reconciles each public v2 callable/HTTP
export with its Cloud Run IAM policy after Firebase reports a successful
deploy. CI cannot exercise the final boundary: it has no disposable live GCP
project in which it may deploy functions and mutate Cloud Run IAM.

The kd tests therefore mock Cloud Run service listing and IAM commands. They
cover an existing `allUsers` `roles/run.invoker` binding, repair of an empty
policy, a failed repair that prints the exact recovery command, and exclusion
of an export whose immediately preceding JSDoc contains
`@kanna-private-function`. That annotation only opts out of kd reconciliation;
a private endpoint must also declare the appropriate Firebase `invoker` option
so the underlying deploy is private.

## Incident verification (staging, 2026-08-22)

In project `kanna-staging`, region `us-central1`, the Cloud Run IAM policies for
`createcheckoutsession`, `deleteaccount`, and `stripewebhook` were empty. The
manager manually ran the following command for each service:

```sh
gcloud run services add-iam-policy-binding SERVICE --member=allUsers --role=roles/run.invoker --project=kanna-staging --region=us-central1
```

Afterward, an unsigned Stripe webhook reached function code and returned its
signature-check `400`, while an unauthenticated callable request reached the
callable layer and returned `401`. Before repair, Cloud Run rejected both at
the front door with `403` and an empty-Authorization-header error.

The root-cause sequence cannot be proven from the repository alone. Inspection
of the pinned `firebase-tools` 14.27.0 implementation found that v2 creation
sets a public invoker for HTTP and callable triggers. Its update path revisits
ordinary HTTP invokers when discovery marks them implicit-public, but does not
have a corresponding callable-update branch. Its deployment reporter also
warns that an implicit public binding which fails during creation may require
an explicit public invoker on a later deploy. This supports a create-time IAM
failure as a plausible contributor, especially for the callables, but does not
prove why the HTTP webhook remained empty. The kd reconciliation deliberately
does not depend on that history.

## Manual re-verification

Deploy through kd, then inspect all source-derived services:

```sh
./kd cloud deploy --staging --functions
gcloud run services get-iam-policy createcheckoutsession --project=kanna-staging --region=us-central1 --format=json
gcloud run services get-iam-policy deleteaccount --project=kanna-staging --region=us-central1 --format=json
gcloud run services get-iam-policy stripewebhook --project=kanna-staging --region=us-central1 --format=json
```

Each policy must contain a `roles/run.invoker` binding whose members include
`allUsers`. Resolve the live function URIs rather than guessing them, then
repeat the boundary probes:

```sh
gcloud functions describe stripeWebhook --gen2 --project=kanna-staging --region=us-central1 --format='value(serviceConfig.uri)'
gcloud functions describe createCheckoutSession --gen2 --project=kanna-staging --region=us-central1 --format='value(serviceConfig.uri)'
```

An unsigned POST to the webhook URI must reach signature validation (`400`),
and a callable-protocol POST without Firebase authentication must reach the
callable/function authentication layer (`401`), rather than either request
being rejected by Cloud Run (`403`).

This gap can close when CI has a purpose-built ephemeral GCP project and
credentials authorized to deploy gen2 functions, inspect IAM, remove the
binding, run kd reconciliation, and assert both the restored policy and HTTP
boundary behavior.
