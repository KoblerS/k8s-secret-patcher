# Secret patcher for Kubernetes

## Introduction

A simple Kubernetes NodeJS application that creates and patches imagePullSecrets to service accounts in all Kubernetes namespaces to allow cluster-wide authenticated access to private docker container registries.

## Configuration

To control feature of the secret-patcher you can use the following environment variables:

| Environment Variable        | Type    | Default               | Description                                                                                   | 
| :-------------------------: | :-----: | :-------------------: | :-------------------------------------------------------------------------------------------: |
| CONFIG_SERVICEACCOUNT       | String  | "default"             | Service account which will be patched                                                         |
| CONFIG_SECRET               | String  | ""                    | Base64 encoded docker config in JSON format                                                   |
| CONFIG_EXCLUDED_NAMESPACES  | List    | default,kube-system   | Excluded namespaces which will not be patched                                                 |
| CONFIG_WATCH_CHANGES        | String  | true                  | Watch for new namespaces and patch them automatically                                         |
| CONFIG_LOOP_DURATION        | Integer | 0 seconds             | Define in seconds how often the script should try to patch existing namespaces (0 = disabled) |
| CONFIG_BLIND_TIME           | Integer | 10 seconds            | Time which the watcher should wait until to start watching                                    |
| CONFIG_WAIT_SETUP_TIME      | Integer | 60 seconds            | Time the script should wait until the namespace is created                                    |

To disable specific namespaces you can use the following annotation:

```
k8s.secret-patcher/skip-patching: true
```

## Why

To deploy private images to Kubernetes, we need to provide the credential to the private docker registries in either

Pod definition (https://kubernetes.io/docs/concepts/containers/images/#specifying-imagepullsecrets-on-a-pod)
Default service account in a namespace (https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#add-imagepullsecrets-to-a-service-account)

With the second approach, a Kubernetes cluster admin configures the default service accounts in each namespace, and a Pod deployed by developers automatically inherits the image-pull-secret from the default service account in Pod's namespace.

This is done manually by following command for each Kubernetes namespace.

```
kubectl create secret docker-registry image-pull-secret \
  -n <your-namespace> \
  --docker-server=<your-registry-server> \
  --docker-username=<your-name> \
  --docker-password=<your-pword> \
  --docker-email=<your-email>

kubectl patch serviceaccount default \
  -p "{\"imagePullSecrets\": [{\"name\": \"image-pull-secret\"}]}" \
  -n <your-namespace>
```

And it could be automated with a simple program like this secret-patcher application.

## TODOS

- Watch on serviceaccounts instead of namespace
- 