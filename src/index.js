const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const watch = new k8s.Watch(kc);

/**
 * Environment configuration
 */
const CONFIG_SECRET_NAME      = process.env.CONFIG_SECRET_NAME          || "pull-secret-patcher", // Default: "pull-secret-patcher"
  CONFIG_SECRET               = process.env.CONFIG_SECRET               || "",
  CONFIG_LOOP_DURATION        = process.env.CONFIG_LOOP_DURATION        || 0,                     // Default 0 seconds
  CONFIG_EXCLUDED_NAMESPACES  = process.env.CONFIG_EXCLUDED_NAMESPACES  || "default,kube-system", // Default: "default,kube-system"
  CONFIG_WATCH_CHANGES        = process.env.CONFIG_WATCH_CHANGES        || true,                  // Default: true
  CONFIG_BLIND_TIME           = process.env.CONFIG_BLIND_TIME           || 10,                    // Default: 10 seconds
  CONFIG_WAIT_SETUP_TIME      = process.env.CONFIG_WAIT_SETUP_TIME      || 60;                    // Default: 60 seconds

if (!CONFIG_SECRET) {
  console.error('CONFIG_SECRET environment variable is missing!');
  process.exit(1);
}
if (CONFIG_LOOP_DURATION < 0) {
  console.error('CONFIG_LOOP_DURATION cant be lower 0!');
  process.exit(1);
}
if (CONFIG_BLIND_TIME < 0) {
  console.error('CONFIG_BLIND_TIME cant be lower 0!');
  process.exit(1);
}
if (CONFIG_WAIT_SETUP_TIME < 0) {
  console.error('CONFIG_WAIT_SETUP_TIME cant be lower 0!');
  process.exit(1);
}
if (CONFIG_EXCLUDED_NAMESPACES.endsWith(',')) {
  console.error('Invalid CONFIG_EXCLUDED_NAMESPACES!');
  process.exit(1);
}
if (CONFIG_WATCH_CHANGES != true &&
  CONFIG_WATCH_CHANGES != false) {
  console.error('Invalid CONFIG_WATCH_CHANGES (can only be true or fales)');
  process.exit(1);
}

// Start scanning
startScanner();

function startScanner() {
  readNameSpaces()
    .finally(() => {
      if (CONFIG_LOOP_DURATION > 0) {
        setTimeout(startScanner, CONFIG_LOOP_DURATION * 1000);
      }
    });
}

/**
 * Watch for new namespaces if enabled
 */
if (CONFIG_WATCH_CHANGES) {
  let blind = true;
  setTimeout(() => {
    blind = false;
  }, CONFIG_BLIND_TIME * 1000);
  console.info('Started watching for new namespaces ...');
  watch.watch('/api/v1/namespaces', {}, (phase, obj, watchObj) => {
    if (phase == 'ADDED' && blind == false) {
      const name = obj.metadata.name;
      console.info(`Found new namespace called ${name} giving some time to setup correctly ...`);

      // Wait some seconds before patching namespace in order to get resources setup
      setTimeout(() => {
        console.info(`Starting patching of namespace: ${name} ...`);
        patchNamespace({ 
          metadata: {
            name: name
          }
        })
        .then(() => {
          console.info(`Finished patching of namespace: ${name}!`);
        })
        .catch(error => {
          console.error(`Failed to patch namespace: ${name}.`)
        });
      }, CONFIG_WAIT_SETUP_TIME * 1000);
    }
  }, error => {
    console.error(error);
  });
}

function readNameSpaces() {
  const greylist = CONFIG_EXCLUDED_NAMESPACES.split(',');
  return k8sApi.listNamespace()
    .then(list => list.body.items.filter(ns => !greylist.includes(ns.metadata.name)))
    .then(list => list.map(hasAnnotation))
    .then(list => Promise.all(list))
    .then(list => list.filter(ns => !ns.status))
    .then(list => list.map(namespace => hasSecret(namespace)))
    .then(list => Promise.all(list))
    .then(list =>{
      return list.map(result => {
        if (result.unchanged)
          return Promise.resolve(result);
        else if (result.status) 
          return patchSecret(result);
        else
          return createSecret(result);
      })})
    .then(list => Promise.all(list))
    .then(list => list.map(result => patchServiceAccount(result)))
    .then(list => Promise.all(list))
    .then(list => list.map(result => restartErroredPods(result)))
    .then(list => Promise.all(list))
    .catch(() => {});
}

/**
 * Patch only a given namespace
 */
function patchNamespace(name) {
  if (CONFIG_EXCLUDED_NAMESPACES.split(',').includes(name)) {
    console.info(`Skipping namespace ${name} due too greylist matching item.`);
    return;
  }
  return hasAnnotation(name)
    .then(hasSecret)
    .then(result => {
      if (result.status) 
          return patchSecret(result);
        else
          return createSecret(result);
    })
    .then(patchServiceAccount)
    .then(restartErroredPods)
    .then(list => Promise.all(list))
    .catch(() => {});
}

/**
 * Check if namespace has annotation which will block patching
 * Annotation name: k8s.secret-patcher/skip-patching must be true in order to cancel patching
 */
function hasAnnotation(properties) {
  return new Promise((resolve, reject) => {
    k8sApi.readNamespace(properties.metadata.name).then(definition => {
      if (definition.body.metadata.annotations &&
        definition.body.metadata.annotations['k8s.secret-patcher/skip-patching'] &&
        definition.body.metadata.annotations['k8s.secret-patcher/skip-patching'] == "true") {
        console.info(`Namespace: ${properties.name} will not be updated due too annotation restricts it.`);
        reject();
      } else {
        resolve({
          status: false,
          name: properties.metadata.name
        });
      }
    }).catch(error => {
      console.error(error);
      reject();
    });
  });
}

/**
 * Check if namespace has already a configured
 */
function hasSecret(properties) {
  return new Promise((resolve, reject) => {
    k8sApi.readNamespacedSecret(CONFIG_SECRET_NAME, properties.name).then(info => {
      if (info.body.data['.dockerconfigjson'] == CONFIG_SECRET) {
        console.info(`Secret for namespace: ${properties.name} unchanged and will not be updated.`);
        resolve({
          status: false,
          unchanged: true,
          name: properties.name
        });
      } else {
        resolve({
          status: true,
          unchanged: false,
          name: properties.name
        });
      }
    }).catch(error => { 
      // If 404 then accept it as non error
      if (error.statusCode == 404)
        return resolve({
          status: false,
          unchanged: false,
          name: properties.name
        });
      console.error('Could not find any secrets in namespace maybe its not correctly setup?');
      resolve({
        status: false,
        name: properties.name
      });
    });
  });
}

function createSecret(properties) {
  return new Promise((resolve, reject) => {
    k8sApi.createNamespacedSecret(properties.name, {
      apiVersion: 'v1',
      data: {
        '.dockerconfigjson': CONFIG_SECRET
      },
      kind: 'Secret',
      type: 'kubernetes.io/dockerconfigjson',
      metadata: {
        name: CONFIG_SECRET_NAME
      }
    }).then(info => {
      resolve({
        status: true,
        name: properties.name
      });
    }).catch(error => {
      console.error(`Could not create secret in namespace: ${properties.name}.`);
      resolve({
        status: false,
        name: properties.name
      });
    });
  });
}

function patchSecret(properties) {
  const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH}};
  return new Promise((resolve, reject) => {
    k8sApi.patchNamespacedSecret(CONFIG_SECRET_NAME, properties.name, [{
      "op": "replace",
      "path":"/data",
      "value": {
        '.dockerconfigjson': CONFIG_SECRET
      }
    }], undefined, undefined, undefined, undefined, options).then(result => {
      console.info('Patched service account for namespace: ' + properties.name);
      resolve({
        status: true,
        name: properties.name
      })
    }).catch(error => {
      console.error(`Could not patch secret of namespace ${properties.name}`);
      console.error(error);
      resolve({
        status: false,
        name: properties.name
      });
    });
  });
}

function patchServiceAccount(properties) {
  const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH}};
  return new Promise((resolve, reject) => {
    k8sApi.listNamespacedServiceAccount(properties.name).then(serviceAccountResult => {
      const patchArray = [];
      serviceAccountResult.body.items.forEach(serviceaccount => {
        if (!serviceaccount.imagePullSecrets) {
          patchArray.push(k8sApi.patchNamespacedServiceAccount(serviceaccount.metadata.name, properties.name, [{
            "op": "replace",
            "path":"/imagePullSecrets",
            "value": [{
              name: CONFIG_SECRET_NAME
            }]
          }], undefined, undefined, undefined, undefined, options));
        }
      });
      Promise.all(patchArray).then((finalStatus, finalErrored) => {
        finalStatus.forEach(serviceaccount => {
          console.error(`Patched serviceaccounts ${serviceaccount.body.metadata.name} of namespace ${properties.name}`);
        });
        resolve({
          name: properties.name
        })
      }).catch(error => {
        console.error(error);
        console.error(`Could not patch serviceaccounts of namespace ${properties.name}`);
        resolve({
          status: false,
          name: properties.name
        });
      });
    }).catch(error => {
      console.error(`Could not list serviceaccounts of namespace ${properties.name}`);
      resolve({
        status: false,
        name: properties.name
      });
    });
  });
}

function restartErroredPods(properties) {
  return new Promise((resolve, reject) => {
    k8sApi.listNamespacedPod(properties.name).then(result => {
      const deletionArray = [];
      if (result.body.items.length &&
        result.body.items.length > 0) {
        result.body.items.forEach(pod => {
          if (pod.status.containerStatuses && 
            pod.status.containerStatuses.length > 0 && 
            pod.status.containerStatuses[0].state &&
            pod.status.containerStatuses[0].state.waiting &&
            (pod.status.containerStatuses[0].state.waiting.reason == "ImagePullBackOff" ||
            pod.status.containerStatuses[0].state.waiting.reason == "ErrImagePull")) {
            console.info(`Restarting pod ${pod.metadata.name} due too ImagePullBackOff state!`);
            deletionArray.push(deletePod({
              name: properties.name,
              podName: pod.metadata.name
            }));
          }
        });
      }
      resolve(deletionArray);
    }).catch(error => {
      console.error(`Could not get pods for namespace: ${properties.name}`);
      resolve({
        status: false,
        name: properties.name
      });
    });
  });
}

function deletePod(properties) {
  return new Promise((resolve, reject) => {
    k8sApi.deleteNamespacedPod(properties.podName, properties.name).then(result => {
      resolve({
        name: properties.name,
        result: true
      });
      console.info(`Pod ${properties.podName} was successfully deleted!`);
    }).catch(error => {
      console.error(`Error occured while deleting pod: ${properties.podName}`);
      resolve({
        status: false,
        name: properties.name
      });
    });
  });
}
