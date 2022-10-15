import { remote } from 'electron';
import { debug, info } from 'electron-log';
import { copy, ensureDir } from 'fs-extra';
import { join } from 'path';
import * as compose from 'docker-compose';
import Dockerode, { DockerOptions } from 'dockerode';
import yaml from 'js-yaml';
import os from 'os';
import {
  BitcoinNode,
  CLightningNode,
  CommonNode,
  EclairNode,
  LightningNode,
  LndNode,
} from 'shared/types';
import stripAnsi from 'strip-ansi';
import { DockerLibrary, DockerVersions, Network, NetworksFile } from 'types';
import { legacyDataPath, networksPath, nodePath } from 'utils/config';
import { APP_VERSION, dockerConfigs } from 'utils/constants';
import { exists, read, write } from 'utils/files';
import { migrateNetworksFile } from 'utils/migrations';
import { isLinux } from 'utils/system';
import ComposeFile from './composeFile';

class DockerService implements DockerLibrary {
  /** The path to the Docker socket file */
  private dockerSocketPath?: string;
  /** The path to the `docker-compose` CLI executable */
  private composeFilePath?: string;

  /** A `Dockerode` instance */
  get docker() {
    const opts: DockerOptions = {};
    if (this.dockerSocketPath) opts.socketPath = this.dockerSocketPath;
    return new Dockerode(opts);
  }

  /**
   * Store the custom docker paths so that these values won't need to be passed
   * for every function that is called
   */
  setPaths(dockerSocketPath: string, composeFilePath: string) {
    this.dockerSocketPath = dockerSocketPath || undefined;
    this.composeFilePath = composeFilePath || undefined;
  }

  /**
   * Gets the versions of docker and docker-compose installed
   * @param throwOnError set to true to throw an Error if detection fails
   */
  async getVersions(throwOnError?: boolean): Promise<DockerVersions> {
    const versions = { docker: '', compose: '' };

    try {
      debug('fetching docker version');
      const dockerVersion = await this.docker.version();
      debug(`Result: ${JSON.stringify(dockerVersion)}`);
      versions.docker = dockerVersion.Version;
    } catch (error: any) {
      debug(`Failed: ${error.message}`);
      if (throwOnError) throw error;
    }

    try {
      debug('getting docker-compose version');
      const composeVersion = await this.execute(compose.version, this.getOpts());
      debug(`Result: ${JSON.stringify(composeVersion)}`);
      versions.compose = composeVersion.out.trim();
    } catch (error: any) {
      debug(`Failed: ${error.message}`);
      if (throwOnError) throw error;
    }

    return versions;
  }

  /**
   * Gets a list of the polar images that have already been pulled
   */
  async getImages(): Promise<string[]> {
    try {
      debug('fetching docker images');
      const allImages = await this.docker.listImages();
      debug(`All Images: ${JSON.stringify(allImages)}`);
      const imageNames = ([] as string[])
        .concat(...allImages.map(i => i.RepoTags || []))
        .filter(n => n !== '<none>:<none>'); // ignore untagged images
      const uniqueNames = imageNames.filter(
        (image, index) => imageNames.indexOf(image) === index,
      );
      debug(`Image Names: ${JSON.stringify(uniqueNames)}`);
      return uniqueNames;
    } catch (error: any) {
      debug(`Failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Save a docker-compose.yml file for the given network
   * @param network the network to save a compose file for
   */
  async saveComposeFile(network: Network) {
    const file = new ComposeFile();
    const { bitcoin, lightning } = network.nodes;

    bitcoin.forEach(node => file.addBitcoind(node));
    lightning.forEach(node => {
      if (node.implementation === 'LND') {
        const lnd = node as LndNode;
        const backend = bitcoin.find(n => n.name === lnd.backendName) || bitcoin[0];
        file.addLnd(lnd, backend);
      }
      if (node.implementation === 'c-lightning') {
        const cln = node as CLightningNode;
        const backend = bitcoin.find(n => n.name === cln.backendName) || bitcoin[0];
        file.addClightning(cln, backend);
      }
      if (node.implementation === 'eclair') {
        const eclair = node as EclairNode;
        const backend = bitcoin.find(n => n.name === eclair.backendName) || bitcoin[0];
        file.addEclair(eclair, backend);
      }
    });

    const yml = yaml.dump(file.content);
    const path = join(network.path, 'docker-compose.yml');
    await write(path, yml);
    info(`saved compose file for '${network.name}' at '${path}'`);
  }

  /**
   * Start a network using docker-compose
   * @param network the network to start
   */
  async start(network: Network) {
    const { bitcoin, lightning } = network.nodes;
    await this.ensureDirs(network, [...bitcoin, ...lightning]);

    info(`Starting docker containers for ${network.name}`);
    info(` - path: ${network.path}`);
    const result = await this.execute(compose.upAll, this.getOpts(network));
    info(`Network started:\n ${result.out || result.err}`);
  }

  /**
   * Stop a network using docker-compose
   * @param network the network to stop
   */
  async stop(network: Network) {
    info(`Stopping docker containers for ${network.name}`);
    info(` - path: ${network.path}`);
    const result = await this.execute(compose.down, this.getOpts(network));
    info(`Network stopped:\n ${result.out || result.err}`);
  }

  /**
   * Starts a single service using docker-compose
   * @param network the network containing the node
   * @param node the node to start
   */
  async startNode(network: Network, node: CommonNode) {
    await this.ensureDirs(network, [node]);
    // make sure the docker container is stopped. If it is already started in an error state
    // then starting it would have no effect
    await this.stopNode(network, node);

    info(`Starting docker container for ${node.name}`);
    info(` - path: ${network.path}`);
    const result = await this.execute(compose.upOne, node.name, this.getOpts(network));
    info(`Container started:\n ${result.out || result.err}`);
  }

  /**
   * Stops a single service using docker-compose
   * @param network the network containing the node
   * @param node the node to stop
   */
  async stopNode(network: Network, node: CommonNode) {
    info(`Stopping docker container for ${node.name}`);
    info(` - path: ${network.path}`);
    const result = await this.execute(compose.stopOne, node.name, this.getOpts(network));
    info(`Container stopped:\n ${result.out || result.err}`);
  }

  /**
   * Removes a single service from the network using docker-compose
   * @param network the network containing the node
   * @param node the node to remove
   */
  async removeNode(network: Network, node: CommonNode) {
    info(`Stopping docker container for ${node.name}`);
    info(` - path: ${network.path}`);
    let result = await this.execute(compose.stopOne, node.name, this.getOpts(network));
    info(`Container stopped:\n ${result.out || result.err}`);

    info(`Removing stopped docker containers`);
    // the `any` cast is used because `rm` is the only method on compose that takes the
    // IDockerComposeOptions as the first param and a spread for the remaining
    result = await this.execute(compose.rm as any, this.getOpts(network), node.name);
    info(`Removed:\n ${result.out || result.err}`);
  }

  /**
   * Saves the given networks to disk
   * @param data the list of networks to save
   */
  async saveNetworks(data: NetworksFile) {
    const json = JSON.stringify(data, null, 2);
    const path = join(networksPath, 'networks.json');
    await write(path, json);
    info(`saved networks to '${path}'`);
  }

  /**
   * Loads a list of networks from the file system
   */
  async loadNetworks(): Promise<NetworksFile> {
    const path = join(networksPath, 'networks.json');

    // copy network data from previous version path if necessary
    const legacyNetworksExist = await exists(join(legacyDataPath, 'networks'));
    if (!(await exists(path)) && legacyNetworksExist) {
      await this.copyLegacyData();
    }

    if (await exists(path)) {
      const json = await read(path);
      let data = JSON.parse(json);
      info(`loaded ${data.networks.length} networks from '${path}'`);
      // migrate data when the version differs or running locally
      if (data.version !== APP_VERSION || process.env.NODE_ENV !== 'production') {
        data = migrateNetworksFile(data);
        await this.saveNetworks(data);
      }
      return data;
    } else {
      info(`skipped loading networks because the file '${path}' doesn't exist`);
      return { version: APP_VERSION, networks: [], charts: {} };
    }
  }

  /**
   * copies the network data from the v0.1.0 path to the new path
   */
  async copyLegacyData(): Promise<void> {
    const legacyPath = join(legacyDataPath, 'networks');
    try {
      info(`copying data from v0.1.0 app dir '${legacyPath}' to '${networksPath}'`);
      await copy(legacyPath, networksPath);
    } catch (error: any) {
      info(`failed to copy folder\nfrom: ${legacyPath}\nto: ${networksPath}\n`, error);
    }
  }

  /**
   * Helper method to trap and format exceptions thrown and
   * @param cmd the compose function to call
   * @param arg1 the first argument to the compose function
   * @param arg2 the second argument to the compose function
   */
  private async execute<A, B>(
    cmd: (arg1: A, arg2?: B) => Promise<compose.IDockerComposeResult>,
    arg1: A,
    arg2?: B,
  ): Promise<compose.IDockerComposeResult> {
    try {
      const result = await cmd(arg1, arg2);
      result.out = stripAnsi(result.out);
      result.err = stripAnsi(result.err);
      return result;
    } catch (e: any) {
      e.err = stripAnsi(e.err);
      info(`docker cmd failed: ${JSON.stringify(e)}`);
      throw new Error(e.err || JSON.stringify(e));
    }
  }

  /**
   * Returns options for all docker compose calls
   */
  private getOpts(network?: Network) {
    const opts: compose.IDockerComposeOptions = {
      cwd: network ? network.path : __dirname,
      env: {
        ...process.env,
        ...(remote && remote.process ? remote.process.env : {}),
      },
    };

    if (this.composeFilePath) {
      opts.executablePath = this.composeFilePath;
    }

    if (isLinux()) {
      const { uid, gid } = os.userInfo();
      debug(`env: uid=${uid} gid=${gid}`);
      opts.env = {
        ...opts.env,
        // add user/group id's to env so that file permissions on the
        // docker volumes are set correctly. containers cannot write
        // to disk on linux if permissions aren't set correctly
        USERID: `${uid}`,
        GROUPID: `${gid}`,
      } as NodeJS.ProcessEnv;
    }

    debug('docker-compose options', opts);
    return opts;
  }

  private async ensureDirs(network: Network, nodes: CommonNode[]) {
    // create the directory so the owner is the current host user
    // if this isn't done, then docker will create the folders
    // owned by root and linux containers won't start up due to
    // permission errors
    for (const commonNode of nodes) {
      // need to cast so typescript doesn't complain about 'implementation'
      const node = commonNode as LightningNode | BitcoinNode;
      const nodeDir = nodePath(network, node.implementation, node.name);
      await ensureDir(nodeDir);
      if (node.implementation === 'c-lightning') {
        const { dataDir, apiDir } = dockerConfigs['c-lightning'];
        await ensureDir(join(nodeDir, dataDir as string));
        await ensureDir(join(nodeDir, apiDir as string));
      }
    }
  }
}

export default new DockerService();
