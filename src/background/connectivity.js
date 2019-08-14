/* eslint-disable-next-line no-unused-vars */
class Connectivity extends Component {
  constructor(receiver) {
    super(receiver);
  }

  init() {
    // proxy setting change observer
    browser.experiments.proxyutils.onChanged.addListener(async _ => {
      return this.sendMessage("proxySettingsChanged");
    });

    // connectivity observer.
    browser.experiments.proxyutils.onConnectionChanged.addListener(async connectivity => {
      return this.sendMessage("connectivityChanged", { connectivity });
    });
  }
}