import {Connectivity} from "./connectivity.js";
import {FxAUtils} from "./fxa.js";
import {Network} from "./network.js";
import {StorageUtils} from "./storage.js";
import {Survey} from "./survey.js";
import {UI} from "./ui.js";

// If run() fails, it will be retriggered after this timeout (in milliseconds)
const RUN_TIMEOUT = 5000; // 5 secs

class Main {
  constructor() {
    log("constructor");

    this.observers = new Set();

    this.connectivity = new Connectivity(this);
    this.fxa = new FxAUtils(this);
    this.net = new Network(this);
    this.survey = new Survey(this);
    this.ui = new UI(this);

    this.proxyState = PROXY_STATE_LOADING;

    // Timeout for run() when offline is detected.
    this.runTimeoutId = 0;

    this.handlingEvent = false;
    this.pendingEvents = [];
  }

  async init() {
    const prefs = await browser.experiments.proxyutils.settings.get({});
    debuggingMode = true || prefs.value.debuggingEnabled;

    log("init");

    // Let's initialize the observers.
    for (let observer of this.observers) {
      await observer.init(prefs);
    }

    // All good. Let's start.
    await this.firstRun();
  }

  async firstRun() {
    log("first run!");

    let proxyState = await StorageUtils.getProxyState();
    if (proxyState === PROXY_STATE_ACTIVE) {
      this.setProxyState(PROXY_STATE_ACTIVE);
      await this.ui.update(false /* no toast here */);
      return;
    }

    await this.run();
  }

  // This method is executed multiple times: at startup time, and each time we
  // go back online. It computes the proxy state.
  async run() {
    log("run!");

    clearTimeout(this.runTimeoutId);

    // Here we generate the current proxy state.
    await this.computeProxyState();

    // UI
    const showToast =
       this.proxyState !== PROXY_STATE_ACTIVE &&
       this.proxyState !== PROXY_STATE_INACTIVE;
    await this.ui.update(showToast);
  }

  setProxyState(proxyState) {
    this.proxyState = proxyState;

    for (let observer of this.observers) {
      observer.setProxyState(proxyState);
    }
  }

  setOfflineAndStartRecoveringTimer() {
    log("set offline state and start the timer");

    this.setProxyState(PROXY_STATE_OFFLINE);

    clearTimeout(this.runTimeoutId);
    this.runTimeoutId = setTimeout(_ => this.run(), RUN_TIMEOUT);
  }

  // Set this.proxyState based on the current settings.
  async computeProxyState() {
    log("computing status - currently: " + this.proxyState);

    // This method will schedule the token generation, if needed.
    if (this.tokenGenerationTimeout) {
      clearTimeout(this.tokenGenerationTimeout);
      this.tokenGenerationTimeout = 0;
    }

    // We want to keep these states.
    let currentState = this.proxyState;
    if (currentState !== PROXY_STATE_AUTHFAILURE &&
        currentState !== PROXY_STATE_PROXYERROR &&
        currentState !== PROXY_STATE_PROXYAUTHFAILED) {
      this.setProxyState(PROXY_STATE_UNAUTHENTICATED);
    }

    // Something else is in use.
    let otherProxyInUse = await this.hasProxyInUse();
    if (otherProxyInUse) {
      this.setProxyState(PROXY_STATE_OTHERINUSE);
    }

    // All seems good. Let's see if the proxy should enabled.
    if (this.proxyState === PROXY_STATE_UNAUTHENTICATED) {
      let proxyState = await StorageUtils.getProxyState();
      if (proxyState === PROXY_STATE_INACTIVE) {
        this.setProxyState(PROXY_STATE_INACTIVE);
      } else if ((await this.fxa.maybeGenerateTokens())) {
        this.setProxyState(PROXY_STATE_CONNECTING);

        // Note that we are not waiting for this function. The code moves on.
        // eslint-disable-next-line verify-await/check
        this.testProxyConnection();
      }
    }

    // If we are here we are not active yet. At least we are connecting.
    // Restore default settings.
    if (currentState !== this.proxyState) {
      this.net.inactiveSteps();
    }

    log("computing status - final: " + this.proxyState);
    return currentState !== this.proxyState;
  }

  async testProxyConnection() {
    try {
      await this.net.testProxyConnection();

      await StorageUtils.setProxyState(PROXY_STATE_ACTIVE);
      this.setProxyState(PROXY_STATE_ACTIVE);

      this.net.syncAfterConnectionSteps();
      await this.ui.afterConnectionSteps();
    } catch (e) {
      this.setOfflineAndStartRecoveringTimer();
      await this.ui.update();
    }
  }

  async enableProxy(value) {
    log("enabling proxy: " + value);

    // We support the changing of proxy state only from some states.
    if (this.proxyState !== PROXY_STATE_UNAUTHENTICATED &&
        this.proxyState !== PROXY_STATE_ACTIVE &&
        this.proxyState !== PROXY_STATE_INACTIVE &&
        this.proxyState !== PROXY_STATE_CONNECTING) {
      return;
    }

    // Let's force a new proxy state, and then let's compute it again.
    let proxyState = value ? PROXY_STATE_CONNECTING : PROXY_STATE_INACTIVE;
    await StorageUtils.setProxyState(proxyState);

    if (await this.computeProxyState()) {
      await this.ui.update();
    }
  }

  async auth() {
    // non authenticate state.
    this.setProxyState(PROXY_STATE_UNAUTHENTICATED);

    try {
      await this.fxa.authenticate();
      log("Authentication completed");

      // We are in an inactive state at this point.
      this.setProxyState(PROXY_STATE_INACTIVE);

      // Let's enable the proxy.
      return this.enableProxy(true);
    } catch (error) {
      log(`Authentication failed: ${error.message}`);
      return this.authFailure();
    }
  }

  async authFailure() {
    this.setProxyState(PROXY_STATE_AUTHFAILURE);
    await StorageUtils.setProxyState(this.proxyState);
    await StorageUtils.resetAllTokenData();
  }

  async onConnectivityChanged(connectivity) {
    log("connectivity changed!");
    this.net.increaseConnectionIsolation();

    // Offline -> online.
    if ((this.proxyState === PROXY_STATE_OFFLINE) && connectivity) {
      await this.run();
    }
  }

  async hasProxyInUse() {
    let proxySettings = await browser.proxy.settings.get({});
    return ["manual", "autoConfig", "autoDetect"].includes(proxySettings.value.proxyType);
  }

  async proxyAuthenticationFailed() {
    if (this.proxyState !== PROXY_STATE_ACTIVE &&
        this.proxyState !== PROXY_STATE_CONNECTING) {
      return;
    }

    this.setProxyState(PROXY_STATE_PROXYAUTHFAILED);

    await StorageUtils.resetDynamicTokenData();

    await Promise.all([
      this.ui.update(),
      this.fxa.maybeGenerateTokens(),
    ]);
  }

  async proxyGenericError() {
    if (this.proxyState !== PROXY_STATE_ACTIVE &&
        this.proxyState !== PROXY_STATE_CONNECTING) {
      return;
    }

    this.setProxyState(PROXY_STATE_PROXYERROR);
    await this.ui.update();
  }

  syncSkipProxy(requestInfo, url) {
    if (this.ui.isTabExempt(requestInfo.tabId)) {
      return true;
    }

    // eslint-disable-next-line verify-await/check
    if (this.fxa.isAuthUrl(url.origin)) {
      return true;
    }

    return false;
  }

  async proxySettingsChanged() {
    const hasChanged = await this.computeProxyState();
    if (hasChanged) {
      await this.ui.update();
    }
  }

  syncPanelShown() {
    // This is done to make the authentication form appearing faster.
    // We ignore the response and just prefetch
    // eslint-disable-next-line verify-await/check
    this.fxa.prefetchWellKnownData();
  }

  // Provides an async response in most cases
  async handleEvent(type, data) {
    log(`handling event ${type}`);

    // In order to avoid race conditions generated by multiple events running
    // at the same time, we process them 1 by 1. If we are already handling an
    // event, we wait until it is concluded.
    if (this.handlingEvent) {
      log(`Queuing event ${type}`);
      await new Promise(resolve => this.pendingEvents.push(resolve));
      log(`Event ${type} resumed`);
    }

    this.handlingEvent = true;

    let returnValue;
    try {
      returnValue = await this.handleEventInternal(type, data);
    } catch (e) {}

    this.handlingEvent = false;

    if (this.pendingEvents.length) {
      log(`Processing the first of ${this.pendingEvents.length} events`);
      setTimeout(_ => { this.pendingEvents.shift()(); }, 0);
    }

    return returnValue;
  }

  async handleEventInternal(type, data) {
    switch (type) {
      case "authenticationFailed":
        return this.authFailure();

      case "authenticationRequired":
        return this.auth();

      case "connectivityChanged":
        return this.onConnectivityChanged(data.connectivity);

      case "enableProxy":
        return this.enableProxy(data.enabledState);

      case "managerAccountURL":
        return this.fxa.manageAccountURL();

      case "proxyAuthenticationFailed":
        return this.proxyAuthenticationFailed();

      case "proxyGenericError":
        return this.proxyGenericError();

      case "proxySettingsChanged":
        return this.proxySettingsChanged();

      default:
        console.error("Invalid event: " + type);
        throw new Error("Invalid event: " + type);
    }
  }

  syncHandleEvent(type, data) {
    switch (type) {
      case "skipProxy":
        return this.syncSkipProxy(data.requestInfo, data.url);

      case "panelShown":
        return this.syncPanelShown();

      case "waitForTokenGeneration":
        return this.fxa.waitForTokenGeneration();

      case "excludedDomains":
        return this.fxa.excludedDomains();

      case "tokenGenerated":
        return this.net.tokenGenerated(data.tokenType, data.tokenValue);

      default:
        console.error("Invalid event: " + type);
        throw new Error("Invalid event: " + type);
    }
  }

  registerObserver(observer) {
    // eslint-disable-next-line verify-await/check
    this.observers.add(observer);
  }
}

let main = new Main();
main.init();
