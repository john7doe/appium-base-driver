import _ from 'lodash';
import BaseDriver from '../basedriver/driver';
import { logger, util } from 'appium-support';

const log = logger.getLogger('Protocol Converter');


const COMMAND_URLS_CONFLICTS = [
  {
    commandNames: ['execute', 'executeAsync'],
    jsonwpConverter: (url) => url.replace(/\/execute.*/,
      url.includes('async') ? '/execute_async' : '/execute'),
    w3cConverter: (url) => url.replace(/\/execute.*/,
      url.includes('async') ? '/execute/async' : '/execute/sync'),
  },
  {
    commandNames: ['getElementScreenshot'],
    jsonwpConverter: (url) => url.replace(/\/element\/([^/]+)\/screenshot$/,
      '/screenshot/$1'),
    w3cConverter: (url) => url.replace(/\/screenshot\/([^/]+)/,
      '/element/$1/screenshot'),
  },
  {
    commandNames: ['getWindowHandles', 'getWindowHandle'],
    jsonwpConverter: (url) => {
      return /\/window$/.test(url)
        ? url.replace(/\/window$/, '/window_handle')
        : url.replace(/\/window\/handle(s?)$/, '/window_handle$1');
    },
    w3cConverter: (url) => {
      return /\/window_handle$/.test(url)
        ? url.replace(/\/window_handle$/, '/window')
        : url.replace(/\/window_handles$/, '/window/handles');
    },
  },
];

const {MJSONWP, W3C} = BaseDriver.DRIVER_PROTOCOL;


class ProtocolConverter {
  constructor (proxyFunc) {
    this.proxyFunc = proxyFunc;
    this._downstreamProtocol = null;
  }

  set downstreamProtocol (value) {
    this._downstreamProtocol = value;
  }

  get downstreamProtocol () {
    return this._downstreamProtocol;
  }

  /**
   * W3C /timeouts can take as many as 3 timeout types at once, MJSONWP /timeouts only takes one
   * at a time. So if we're using W3C and proxying to MJSONWP and there's more than one timeout type
   * provided in the request, we need to do 3 proxies and combine the result
   *
   * @param {Object} body Request body
   * @return {Array} Array of W3C + MJSONWP compatible timeout objects
   */
  getTimeoutRequestObjects (body) {
    if (this.downstreamProtocol === W3C && _.has(body, 'ms') && _.has(body, 'type')) {
      const typeToW3C = (x) => x === 'page load' ? 'pageLoad' : x;
      return [{
        [typeToW3C(body.type)]: body.ms,
      }];
    }

    if (this.downstreamProtocol === MJSONWP && (!_.has(body, 'ms') || !_.has(body, 'type'))) {
      const typeToJSONWP = (x) => x === 'pageLoad' ? 'page load' : x;
      return _.toPairs(body)
        // Only transform the entry if ms value is a valid positive float number
        .filter((pair) => /^\d+(?:[.,]\d*?)?$/.test(`${pair[1]}`))
        .map((pair) => {
          return {
            type: typeToJSONWP(pair[0]),
            ms: pair[1],
          };
        });
    }

    return [body];
  }

  /**
   * Proxy an array of timeout objects and merge the result
   * @param {String} url Endpoint url
   * @param {String} method Endpoint method
   * @param {Object} body Request body
   */
  async proxySetTimeouts (url, method, body) {
    let response, resBody;

    const timeoutRequestObjects = this.getTimeoutRequestObjects(body);
    log.debug(`Will send the following request bodies to /timeouts: ${JSON.stringify(timeoutRequestObjects)}`);
    for (const timeoutObj of timeoutRequestObjects) {
      [response, resBody] = await this.proxyFunc(url, method, timeoutObj);

      // If we got a non-MJSONWP response, return the result, nothing left to do
      if (this.downstreamProtocol !== MJSONWP) {
        return [response, resBody];
      }

      // If we got an error, return the error right away
      if (response.statusCode >= 400) {
        return [response, resBody];
      }

      // ...Otherwise, continue to the next timeouts call
    }
    return [response, resBody];
  }

  async proxySetWindow (url, method, body) {
    const bodyObj = util.safeJsonParse(body);
    if (_.isPlainObject(bodyObj)) {
      if (this.downstreamProtocol === W3C && _.has(bodyObj, 'name') && !_.has(bodyObj, 'handle')) {
        log.debug(`Reassigned 'name' value '${bodyObj.name}' to 'handle' as per W3C spec`);
        return await this.proxyFunc(url, method, {handle: bodyObj.name});
      }
      if (this.downstreamProtocol === MJSONWP && _.has(bodyObj, 'handle') && !_.has(bodyObj, 'name')) {
        log.debug(`Reassigned 'handle' value '${bodyObj.handle}' to 'name' as per JSONWP spec`);
        return await this.proxyFunc(url, method, {name: bodyObj.handle});
      }
    }

    return await this.proxyFunc(url, method, body);
  }

  /**
   * Handle "crossing" endpoints for the case
   * when upstream and downstream drivers operate different protocols
   *
   * @param {string} commandName
   * @param {string} url
   * @param {string} method
   * @param {?string|object} body
   * @returns The proxyfying result as [response, responseBody] tuple
   */
  async convertAndProxy (commandName, url, method, body) {
    if (!this.downstreamProtocol) {
      // There is no point to convert anything if we do not know
      // for which protocol the conversion should be done
      return await this.proxyFunc(url, method, body);
    }

    // Same url, but different arguments
    switch (commandName) {
      case 'timeouts':
        return await this.proxySetTimeouts(url, method, body);
      case 'setWindow':
        return await this.proxySetWindow(url, method, body);
      default:
        break;
    }

    // Same arguments, but different URLs
    for (const {commandNames, jsonwpConverter, w3cConverter} of COMMAND_URLS_CONFLICTS) {
      if (!commandNames.includes(commandName)) {
        continue;
      }

      const rewrittenUrl = this.downstreamProtocol === MJSONWP
        ? jsonwpConverter(url)
        : w3cConverter(url);
      if (rewrittenUrl === url) {
        log.debug(`Did not know how to rewrite the original URL '${url}' ` +
          `for ${this.downstreamProtocol} protocol`);
        break;
      }
      log.info(`Rewrote the original URL '${url}' to '${rewrittenUrl}' ` +
        `for ${this.downstreamProtocol} protocol`);
      return await this.proxyFunc(rewrittenUrl, method, body);
    }

    // No matches found. Proceed normally
    return await this.proxyFunc(url, method, body);
  }
}

export default ProtocolConverter;
