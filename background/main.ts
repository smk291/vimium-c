var Backend: BackendHandlersNS.BackendHandlers;
(function () {
  type Tab = chrome.tabs.Tab;
  type Window = chrome.windows.Window;
  interface IncNormalWnd extends Window {
    incognito: true;
    type: "normal";
  }
  interface ActiveTab extends Tab {
    active: true;
  }
  interface PopWindow extends Window {
    tabs: Tab[];
  }
  interface InfoToCreateMultiTab {
    url: string;
    active: boolean;
    windowId?: number;
    index?: number;
    openerTabId?: number;
    pinned?: boolean;
  }
  const enum UseTab { NoTab = 0, ActiveTab = 1, CurWndTabs = 2, CurShownTabs = 3 }
  type BgCmdNoTab = (this: void, _fakeArg?: undefined) => void;
  type BgCmdActiveTab = (this: void, tabs1: [Tab] | never[]) => void;
  type BgCmdActiveTabOrNoTab = (this: void, tabs1?: [Tab] | never[]) => void;
  type BgCmdCurWndTabs = (this: void, tabs1: Tab[]) => void;
  interface BgCmdInfoNS {
    [kBgCmd.createTab]: UseTab.ActiveTab | UseTab.NoTab;
    [kBgCmd.openUrl]: UseTab.ActiveTab | UseTab.NoTab;

    [kBgCmd.goTab]: UseTab.CurShownTabs;
    [kBgCmd.removeTab]: UseTab.CurWndTabs;
    [kBgCmd.removeTabsR]: UseTab.CurWndTabs;
    [kBgCmd.removeRightTab]: UseTab.CurWndTabs;
    [kBgCmd.togglePinTab]: UseTab.CurWndTabs;
    [kBgCmd.reloadTab]: UseTab.CurWndTabs;
    [kBgCmd.moveTab]: UseTab.CurWndTabs;
    [kBgCmd.visitPreviousTab]: UseTab.CurWndTabs;

    [kBgCmd.moveTabToNextWindow]: UseTab.ActiveTab;
    [kBgCmd.toggleCS]: UseTab.ActiveTab;
    [kBgCmd.searchInAnother]: UseTab.ActiveTab;
    [kBgCmd.reopenTab]: UseTab.ActiveTab;
    [kBgCmd.goToRoot]: UseTab.ActiveTab;
    [kBgCmd.copyTabInfo]: UseTab.ActiveTab;
    [kBgCmd.toggleViewSource]: UseTab.ActiveTab;
    [kBgCmd.toggleVomnibarStyle]: UseTab.ActiveTab;
  }

  interface ReopenOptions extends chrome.tabs.CreateProperties {
    id: number;
    url: string;
  }
  interface OpenUrlOptions {
    incognito?: boolean;
    position?: "start" | "end" | "before" | "after";
    opener?: boolean;
    window?: boolean;
  }
  type ShowPageData = [string, typeof Settings.temp_.shownHash_, number];

  const enum RefreshTabStep {
    start = 0,
    s1, s2, s3, s4,
    end,
  }
  interface SpecialHandlers {
    [kFgReq.setSetting]: (this: void
      , request: SetSettingReq<keyof SettingsNS.FrontUpdateAllowedSettings>, port: Port) => void;
    [kFgReq.gotoSession]: BackendHandlersNS.BackendHandlers["gotoSession_"];
    [kFgReq.checkIfEnabled]: ExclusionsNS.Listener & (
        (this: void, request: FgReq[kFgReq.checkIfEnabled], port?: Frames.Port) => void);
    [kFgReq.parseUpperUrl]: {
      (this: void, request: FgReqWithRes[kFgReq.parseUpperUrl] & { execute: true }, port: Port): void;
      (this: void, request: FgReqWithRes[kFgReq.parseUpperUrl], port?: Port): FgRes[kFgReq.parseUpperUrl];
    };
    [kFgReq.focusOrLaunch]: (this: void, request: MarksNS.FocusOrLaunch, _port?: Port | null, notFolder?: true) => void;
    [kFgReq.setOmniStyle]: (this: void, request: FgReq[kFgReq.setOmniStyle], _port?: Port) => void;
  }

  /** any change to `cRepeat` should ensure it won't be `0` */
  let cOptions: CommandsNS.Options = null as never, cPort: Frames.Port = null as never, cRepeat: number = 1,
  _fakeTabId: number = GlobalConsts.MaxImpossibleTabId,
  needIcon = false, cKey: VKeyCodes = VKeyCodes.None,
  _removeTempTabLock: Promise<void> | null | 0 = Build.BTypes & BrowserType.Firefox ? null : 0, // only for Firefox
  gCmdTimer = 0, gTabIdOfExtWithVomnibar: number = GlobalConsts.TabIdNone;
  const getSecret = (function (this: void): (this: void) => number {
    let secret = 0, time = 0;
    return function (this: void): number {
      const now = Date.now(); // safe for time changes
      if (now - time > GlobalConsts.VomnibarSecretTimeout) {
        secret = 1 + (0 | (Math.random() * 0x6fffffff));
      }
      time = now;
      return secret;
    };
  })();

  function tabsCreate(args: chrome.tabs.CreateProperties, callback?: ((this: void, tab: Tab) => void) | null): 1 {
    let { url } = args, type: Urls.NewTabType | undefined;
    if (!url) {
      delete args.url;
    } else if (!(type = Settings.newTabs_[url])) { /* empty */ }
    else if (type === Urls.NewTabType.browser) {
      delete args.url;
    } else if (type === Urls.NewTabType.vimium) {
      args.url = Settings.cache_.newTabUrl_f;
    }
    Build.BTypes & BrowserType.Edge && (!(Build.BTypes & ~BrowserType.Edge) || OnOther === BrowserType.Edge) &&
      (delete args.openerTabId);
    return chrome.tabs.create(args, callback);
  }
  /** if count <= 1, only open once */
  function openMultiTab(this: void, option: InfoToCreateMultiTab, count: number): void {
    const wndId = option.windowId, hasIndex = option.index != null;
    tabsCreate(option, option.active ? function (tab) {
      tab && tab.windowId !== wndId && selectWnd(tab);
    } : null);
    if (count < 2) { return; }
    option.active = false;
    do {
      hasIndex && ++(option as {index: number}).index;
      chrome.tabs.create(option);
    } while (--count > 1);
  }

  const framesForTab: Frames.FramesMap = Object.create<Frames.Frames>(null),
  onRuntimeError = Utils.runtimeError_,
  NoFrameId = Build.MinCVer < BrowserVer.MinWithFrameId && Build.BTypes & BrowserType.Chrome
      && ChromeVer < BrowserVer.MinWithFrameId;
  function isExtIdAllowed(this: void, extId: string | null | undefined, url?: string): boolean {
    if (extId == null) { extId = "unknown_sender"; }
    let list = Settings.extWhiteList_, stat = list[extId];
    if (stat != null) { return stat; }
    if (Build.BTypes & ~BrowserType.Chrome && (!(Build.BTypes & BrowserType.Chrome) || OnOther !== BrowserType.Chrome)
        && stat == null && url) {
      if (list[new URL(url).host]) {
        return list[extId] = true;
      }
    }
    const backgroundLightYellow = "background-color:#fffbe5";
    console.log("%cReceive message from an extension/sender not in the white list: %c%s",
      backgroundLightYellow, backgroundLightYellow + ";color:red", extId);
    return list[extId] = false;
  }
  function selectFrom(this: void, tabs: Tab[], fixIndexes?: BOOL): ActiveTab {
    Build.BTypes & BrowserType.Firefox && fixIndexes && fixTabsIndexes(tabs);
    for (let i = tabs.length; 0 < --i; ) {
      if (tabs[i].active) {
        return tabs[i] as ActiveTab;
      }
    }
    return tabs[0] as ActiveTab;
  }
  function fixTabsIndexes(tabs: Tab[]): Tab[] {
    if (Build.BTypes & BrowserType.Firefox
        && (!(Build.BTypes & ~BrowserType.Firefox) || OnOther === BrowserType.Firefox)) {
      const len = tabs.length;
      if (len > 0 && tabs[len - 1].index !== len - 1) {
        for (let i = 0; i < len; i++) {
          tabs[i].index = i;
        }
      }
    }
    return tabs;
  }
  function newTabIndex(this: void, tab: Readonly<Tab>, pos: OpenUrlOptions["position"]): number | undefined {
    return pos === "before" ? tab.index : pos === "start" ? 0
      : pos !== "end" ? tab.index + 1 : undefined;
  }
  function makeWindow(this: void, option: chrome.windows.CreateData, state?: chrome.windows.ValidStates | ""
      , callback?: ((wnd: Window) => void) | null): void {
    if (option.focused === false) {
      state !== "minimized" && (state = "normal");
    } else if (state === "minimized") {
      state = "normal";
    }
    if (state && (Build.MinCVer >= BrowserVer.MinCreateWndWithState || !(Build.BTypes & BrowserType.Chrome)
                  || ChromeVer >= BrowserVer.MinCreateWndWithState)) {
      option.state = state;
      state = "";
    }
    const focused = option.focused !== false;
    if (Build.BTypes & BrowserType.Firefox
        && (!(Build.BTypes & ~BrowserType.Firefox) || OnOther === BrowserType.Firefox)) {
      delete option.focused;
    } else {
      option.focused = true;
    }
    chrome.windows.create(option, state || !focused ? function (wnd: Window) {
      callback && callback(wnd);
      if (!wnd) { return; } // do not return lastError: just throw errors for easier debugging
      const opt: chrome.windows.UpdateInfo = focused ? {} : { focused: false };
      state && (opt.state = state);
      chrome.windows.update(wnd.id, opt);
    } : callback || null);
  }
  function makeTempWindow(this: void, tabIdUrl: number | string, incognito: boolean
      , callback: (wnd: Window) => void): void {
    const isId = typeof tabIdUrl === "number", option: chrome.windows.CreateData = {
      type: "normal",
      focused: false,
      incognito,
      state: "minimized",
      tabId: isId ? tabIdUrl as number : undefined,
      url: isId ? undefined : tabIdUrl as string
    };
    if (Build.MinCVer < BrowserVer.MinCreateWndWithState && Build.BTypes & BrowserType.Chrome
        && ChromeVer < BrowserVer.MinCreateWndWithState) {
      option.state = undefined;
      option.left = option.top = 0; option.width = option.height = 50;
    }
    chrome.windows.create(option, callback);
  }
  function safeUpdate(this: void, url: string, secondTimes?: true, tabs1?: [Tab]): void {
    if (!tabs1) {
      if (Utils.isRefusingIncognito_(url) && secondTimes !== true) {
        getCurTab(function (tabs2: [Tab]): void {
          return safeUpdate(url, true, tabs2);
        });
        return;
      }
    } else if (tabs1.length > 0 && tabs1[0].incognito && Utils.isRefusingIncognito_(url)) {
      tabsCreate({ url });
      Utils.resetRe_();
      return;
    }
    const arg = { url }, cb = onRuntimeError;
    if (tabs1) {
      chrome.tabs.update(tabs1[0].id, arg, cb);
    } else {
      chrome.tabs.update(arg, cb);
    }
    Utils.resetRe_();
  }
  function onEvalUrl(this: void, arr: Urls.SpecialUrl): void {
    if (arr instanceof Promise) { arr.then(onEvalUrl); return; }
    Utils.resetRe_();
    switch (arr[1]) {
    case "copy":
      return Backend.showHUD_((arr as Urls.CopyEvalResult)[0], true);
    case "status":
      return Backend.forceStatus_((arr as Urls.StatusEvalResult)[0]);
    }
  }
  function complainNoSession(this: void): void {
    (Build.BTypes & ~BrowserType.Chrome && (!(Build.BTypes & BrowserType.Chrome) || OnOther !== BrowserType.Chrome))
    || Build.MinCVer >= BrowserVer.MinSession || ChromeVer >= BrowserVer.MinSession
      ? Backend.complain_("control tab sessions")
      : Backend.showHUD_(`Vimium C can not control tab sessions before Chrome ${BrowserVer.MinSession}`);
  }
  function upperGitUrls(url: string, path: string): string | void | null {
    const obj = Utils.safeParseURL_(url), host: string = obj ? obj.hostname : "";
    if (!host) { return; }
    if (!(<RegExpI> /git\b|\bgit/i).test(host) || !(<RegExpI> /^[\w\-]+(\.\w+)?$/).test(host)) {
      return;
    }
    let arr = path.split("/"), lastIndex = arr.length - 1;
    if (!arr[lastIndex]) { lastIndex--; arr.pop(); }
    let last = arr[lastIndex];
    if (host === "github.com") {
      if (lastIndex === 3) {
        return last === "pull" || last === "milestone" ? path + "s"
          : last === "tree" ? arr.slice(0, 3).join("/")
          : null;
      } else if (lastIndex === 4 && arr[3] === "releases" && (arr[4] === "tag" || arr[4] === "edit")) {
        return arr.slice(0, 4).join("/");
      } else if (lastIndex > 3) {
        return arr[3] === "blob" ? (arr[3] = "tree", arr.join("/")) : null;
      }
    }
  }
  const isNotVomnibarPage = function (this: void, port: Frames.Port, nolog?: boolean): boolean {
    interface SenderEx extends Frames.Sender { isVomnibar?: boolean; warned?: boolean; }
    const info = port.s as SenderEx;
    if (info.isVomnibar == null) {
      info.isVomnibar = info.u === Settings.cache_.vomnibarPage_f || info.u === Settings.CONST_.VomnibarPageInner_;
    }
    if (info.isVomnibar) { return false; }
    if (!nolog && !info.warned) {
      console.warn("Receive a request from %can unsafe source page%c (should be vomnibar) :\n %s @ tab %o",
        "color:red", "color:auto", info.u, info.t);
      info.warned = true;
    }
    return true;
  } as {
    /** `true` means `port` is NOT vomnibar port */
    (this: void, port: Port, nolog: true): boolean;
    (this: void, port: Frames.Port, nolog?: false): boolean;
  };
  function PostCompletions(this: Port, favIcon0: 0 | 1 | 2, list: Array<Readonly<Suggestion>>
      , autoSelect: boolean, matchType: CompletersNS.MatchType, total: number): void {
    let { u: url } = this.s, favIcon = favIcon0 === 2 ? 2 : 0 as 0 | 1 | 2;
    if (Build.BTypes & BrowserType.Firefox
        && (!(Build.BTypes & ~BrowserType.Firefox) || OnOther === BrowserType.Firefox)
        && list.length > 0 && list[0].type === "tab") {
      favIcon = 2;
    }
    else if (favIcon0 === 1 && Build.BTypes & BrowserType.Chrome
          && (Build.MinCVer >= BrowserVer.MinExtensionContentPageAlwaysCanShowFavIcon
          || ChromeVer >= BrowserVer.MinExtensionContentPageAlwaysCanShowFavIcon)) {
      url = url.substring(0, url.indexOf("/", url.indexOf("://") + 3) + 1);
      const map = framesForTab;
      let frame1 = gTabIdOfExtWithVomnibar >= 0 ? indexFrame(gTabIdOfExtWithVomnibar, 0) : null;
      if (frame1 != null) {
        if (frame1.s.u.startsWith(url)) {
          favIcon = 1;
        } else {
          gTabIdOfExtWithVomnibar = GlobalConsts.TabIdNone;
        }
      }
      if (!favIcon) {
      for (const tabId in map) {
        let frames = map[+tabId] as Frames.Frames;
        for (let i = 1, len = frames.length; i < len; i++) {
          let { s: sender } = frames[i];
          if (sender.i === 0) {
            if (sender.u.startsWith(url)) {
              favIcon = 1;
              gTabIdOfExtWithVomnibar = +tabId;
            }
            break;
          }
        }
        if (favIcon) { break; }
      }
      }
    }
    safePost(this, { N: kBgReq.omni_omni, a: autoSelect, m: matchType, l: list, i: favIcon, t: total });
    Utils.resetRe_();
  }
  function safePost<K extends keyof FullBgReq>(port: Port, req: Req.bg<K>): BOOL {
    try {
      port.postMessage(req);
      return 1;
    } catch { return 0; }
  }
  function indexFrame(this: void, tabId: number, frameId: number): Port | null {
    const ref = framesForTab[tabId];
    if (!ref) { return null; }
    for (let i = 1, len = ref.length; i < len; i++) {
      if (ref[i].s.i === frameId) {
        return ref[i];
      }
    }
    return null;
  }
  function getTabRange(current: number, total: number, countToAutoLimitBeforeScale?: number
      , /** must be positive */ extraCount?: number | null
  ): [number, number] {
    let count = cRepeat;
    if (extraCount) { count += count > 0 ? extraCount : -extraCount; }
    const end = current + count, pos = count > 0;
    return end <= total && end > -2 ? pos ? [current, end] : [end + 1, current + 1] // normal range
      : !cOptions.limited && Math.abs(count) < (countToAutoLimitBeforeScale || total
          ) * GlobalConsts.ThresholdToAutoLimitTabOperation
        ? Math.abs(count) < total ? pos ? [total - count, total] : [0, -count] // go forward and backward
        : [0, total] // all
      : pos ? [current, total] : [0, current + 1] // limited
      ;
  }
  function confirm(this: void, command: string, count: number): boolean {
    let msg = (CommandsData_.availableCommands_[command] as CommandsNS.Description)[0];
    msg = msg.replace(<RegExpOne> / \(use .*|&nbsp\(.*|<br\/>/, "");
    return window.confirm(
`You have asked Vimium C to perform ${count} repeats of the command:
      ${Utils.unescapeHTML_(msg)}

Are you sure you want to continue?`);
  }
  function requireURL <k extends keyof FgReq>(request: Req.fg<k> & BgReq[kBgReq.url], ignoreHash?: true): void {
    if (Exclusions == null || Exclusions.rules_.length <= 0
        || !(ignoreHash || Settings.get_("exclusionListenHash", true))) {
      request.N = kBgReq.url;
      cPort.postMessage(request as Req.bg<kBgReq.url>);
      return;
    }
    request.u = cPort.s.u;
    type T1 = keyof FgReq;
    (requestHandlers as { [K in T1]: (req: FgReq[K], port: Frames.Port) => void; } as {
      [K in T1]: <T extends T1>(req: FgReq[T], port: Frames.Port) => void;
    })[request.H](request, cPort);
  }
  function ensureInnerCSS(this: void, port: Frames.Port): string | null {
    const { s: sender } = port;
    if (sender.f & Frames.Flags.hasCSS) { return null; }
    sender.f |= Frames.Flags.hasCSSAndActed;
    return Settings.cache_.innerCSS;
  }
  /** this functions needs to accept any types of arguments and normalize them */
  function executeAny(command: string, options: CommandsNS.RawOptions | null, count: number | string
      , port: Port | null, lastKey?: VKeyCodes): void {
    count = count !== "-" ? parseInt(count as string, 10) || 1 : -1;
    options && typeof options === "object" ?
        Object.setPrototypeOf(options, null) : (options = null);
    lastKey = (+<number> lastKey || VKeyCodes.None) as VKeyCodes;
    return executeCommand(Utils.makeCommand_(command, options), count, lastKey, port as Port);
  }

  const
  getCurTab = chrome.tabs.query.bind<null, { active: true, currentWindow: true }
      , [(result: [Tab], _ex: FakeArg) => void], 1>(null, { active: true, currentWindow: true }),
  getCurTabs = chrome.tabs.query.bind(null, {currentWindow: true}),
  getCurShownTabs = Build.BTypes & BrowserType.Firefox
      && (!(Build.BTypes & ~BrowserType.Firefox) || OnOther === BrowserType.Firefox)
    ? chrome.tabs.query.bind(null, { currentWindow: true, hidden: false }) : 0 as never,
  getCurWnd = function (populate: boolean, callback: (window: chrome.windows.Window, exArg: FakeArg) => void): 1 {
    const wndId = TabRecency_.lastWnd_;
    return wndId >= 0 ? chrome.windows.get(wndId, { populate }, callback)
      : chrome.windows.getCurrent({ populate }, callback);
  } as {
    (populate: true, callback: (window: (chrome.windows.Window & { tabs: chrome.tabs.Tab[] }) | null | undefined
      , exArg: FakeArg) => void): 1;
    (populate: false, callback: (window: chrome.windows.Window, exArg: FakeArg) => void): 1;
  };
  function findCPort(port: Port | null | undefined): Port | null {
    const frames = framesForTab[port ? port.s.t : TabRecency_.last_];
    return frames ? frames[0] : null as never as Port;
  }

  function openUrlInIncognito(this: void, url: string, active: boolean
      , opts: Readonly<Pick<OpenUrlOptions, "position" | "opener" | "window">>
      , tab: Tab, wnds: Window[]): void {
    let oldWnd: Window | undefined, inCurWnd: boolean;
    oldWnd = wnds.filter(wnd => wnd.id === tab.windowId)[0];
    inCurWnd = oldWnd != null && oldWnd.incognito;
    if (!opts.window && (inCurWnd || (wnds = wnds.filter((wnd: Window): wnd is IncNormalWnd => {
      return wnd.incognito && wnd.type === "normal";
    })).length > 0)) {
      const options: InfoToCreateMultiTab & { windowId: number } = {
        url, active,
        windowId: inCurWnd ? tab.windowId : wnds[wnds.length - 1].id
      };
      if (inCurWnd) {
        options.index = newTabIndex(tab, opts.position);
        opts.opener && (options.openerTabId = tab.id);
      }
      openMultiTab(options, cRepeat);
      return !inCurWnd && active ? selectWnd(options) : undefined;
    }
    return makeWindow({
      url,
      incognito: true, focused: active
    }, oldWnd && oldWnd.type === "normal" ? oldWnd.state : "");
  }
  function standardCreateTab(this: void, url: string, onlyNormal?: boolean, tabs?: [Tab]): void {
    if (cOptions.url || cOptions.urls) {
      BackgroundCommands[kBgCmd.openUrl](tabs);
      return onRuntimeError();
    }
    let tab: Tab | null = null;
    if (!tabs) { /* empty */ }
    else if (tabs.length > 0) { tab = tabs[0]; }
    else if (TabRecency_.last_ >= 0) {
      chrome.tabs.get(TabRecency_.last_, function (lastTab): void {
        standardCreateTab(url, onlyNormal, lastTab && [lastTab]);
      });
      return onRuntimeError();
    }
    if (!tab) {
      openMultiTab({url, active: true}, cRepeat);
      return onRuntimeError();
    }
    if (tab.incognito && onlyNormal) { url = ""; }
    return openMultiTab({
      url, active: tab.active, windowId: tab.windowId,
      index: newTabIndex(tab, cOptions.position)
    }, cRepeat);
  }

  const hackedCreateTab =
      (Build.MinCVer >= BrowserVer.MinNoUnmatchedIncognito || !(Build.BTypes & BrowserType.Chrome)
        || ChromeVer >= BrowserVer.MinNoUnmatchedIncognito
      ? null : [function (wnd): void {
    if (cOptions.url || cOptions.urls) {
      return BackgroundCommands[kBgCmd.openUrl]([selectFrom((wnd as PopWindow).tabs)]);
    }
    if (!wnd) {
      tabsCreate({url: this});
      return onRuntimeError();
    }
    const tab = selectFrom(wnd.tabs);
    if (wnd.incognito && wnd.type !== "normal") {
      // url is disabled to be opened in a incognito window directly
      return hackedCreateTab[1](this, tab, cRepeat > 1 ? (id: number): void => {
        for (let count = cRepeat; 0 < --count; ) {
          chrome.tabs.duplicate(id);
        }
      } : null, wnd.tabs);
    }
    return openMultiTab({
      url: this, active: tab.active, windowId: wnd.type === "normal" ? tab.windowId : undefined,
      index: newTabIndex(tab, cOptions.position)
    }, cRepeat);
  }, function (url, tab, repeat, allTabs): void {
    const urlLower = url.toLowerCase().split("#", 1)[0];
    allTabs = allTabs.filter(function (tab1) {
      const url2 = tab1.url.toLowerCase(), end = url2.indexOf("#");
      return ((end < 0) ? url2 : url2.substring(0, end)) === urlLower;
    });
    if (allTabs.length === 0) {
      chrome.windows.getAll(hackedCreateTab[2].bind(url, tab, repeat));
      return;
    }
    const tabs = allTabs.filter(tab1 => tab1.index >= tab.index);
    tab = tabs.length > 0 ? tabs[0] : allTabs[allTabs.length - 1];
    chrome.tabs.duplicate(tab.id);
    if (repeat) { return repeat(tab.id); }
  }, function (tab, repeat, wnds): void {
    wnds = wnds.filter(function (wnd) {
      return !wnd.incognito && wnd.type === "normal";
    });
    if (wnds.length > 0) {
      return hackedCreateTab[3](this, tab, repeat, wnds[0]);
    }
    return makeTempWindow("about:blank", false, //
    hackedCreateTab[3].bind(null, this, tab, function (newTabId: number, newWndId: number): void {
      chrome.windows.remove(newWndId);
      if (repeat) { return repeat(newTabId); }
    }));
  }, function (url, tab, callback, wnd) {
    tabsCreate({
      active: false,
      windowId: wnd.id,
      url
    }, function (newTab) {
      return makeTempWindow(newTab.id, true, function () {
        chrome.tabs.move(newTab.id, {
          index: tab.index + 1,
          windowId: tab.windowId
        }, function (): void {
          callback && callback(newTab.id, newTab.windowId);
          return selectTab(newTab.id);
        });
      });
    });
  }]) as [
    (this: string, wnd?: PopWindow) => void,
    (this: void, url: string, tab: Tab, repeat: ((this: void, tabId: number) => void) | null, allTabs: Tab[]) => void,
    (this: string, tab: Tab, repeat: ((this: void, tabId: number) => void) | null, wnds: Window[]) => void,
    (this: void, url: string, tab: Tab
      , callback: ((this: void, tabId: number, wndId: number) => void) | null, wnd: Window) => void,
  ];
  function openUrl(url: Urls.Url, workType: Urls.WorkType, tabs?: [Tab] | never[]): void {
    if (typeof url === "string") {
      let mask: string | undefined = cOptions.url_mask;
      if (mask) {
        url = url && url.replace(mask + "", (tabs as Tab[]).length > 0 ? (tabs as [Tab])[0].url : "");
      }
      if (mask = cOptions.id_mask || cOptions.id_mark || cOptions.id_marker) {
        url = url && url.replace(mask + "", chrome.runtime.id);
      }
      if (workType !== Urls.WorkType.FakeType) {
        url = Utils.convertToUrl_(url + "", (cOptions.keyword || "") + "", workType);
      }
    }
    const reuse: ReuseType = cOptions.reuse == null ? ReuseType.newFg : (cOptions.reuse | 0),
    options = cOptions as OpenUrlOptions;
    cOptions = null as never;
    Utils.resetRe_();
    return typeof url !== "string" ? onEvalUrl(url as Urls.SpecialUrl)
      : openShowPage[0](url, reuse, options) ? void 0
      : Utils.isJSUrl_(url) ? openJSUrl(url)
      : reuse === ReuseType.reuse ? requestHandlers[kFgReq.focusOrLaunch]({ u: url })
      : reuse === ReuseType.current ? safeUpdate(url)
      : tabs ? openUrlInNewTab(url, reuse, options, tabs as [Tab])
      : void getCurTab(openUrlInNewTab.bind(null, url, reuse, options))
      ;
  }
  function openCopiedUrl(this: void, tabs: [Tab] | never[] | undefined, url: string | null): void {
    if (url === null) { return Backend.complain_("read clipboard"); }
    if (!(url = url.trim())) { return Backend.showHUD_("No text copied!"); }
    if (Utils.quotedStringRe_.test(url)) {
      url = url.slice(1, -1);
    } else {
      const kw: any = cOptions.keyword;
      if (!kw || kw === "~") {
        url = Utils.detectLinkDeclaration_(url);
      }
    }
    return openUrl(url, Urls.WorkType.ActAnyway, tabs);
  }
  function openUrlInNewTab(this: void, url: string, reuse: ReuseType
      , options: Readonly<Pick<OpenUrlOptions, "position" | "opener" | "window" | "incognito">>
      , tabs: [Tab]): void {
    const tab = tabs[0] as Tab | undefined, tabIncognito = tab ? tab.incognito : false,
    { incognito } = options, active = reuse !== ReuseType.newBg;
    let window = options.window;
    if (Utils.isRefusingIncognito_(url)) {
      if (tabIncognito || TabRecency_.incognito_ === IncognitoType.true) {
        window = true;
      }
    } else if (tabIncognito) {
      if (incognito !== false) {
        return openUrlInIncognito(url, active, options, tab as Tab
          , [{ id: (tab as Tab).windowId, incognito: true } as Window]);
      }
      window = true;
    } else if (incognito) {
      chrome.windows.getAll(openUrlInIncognito.bind(null, url, active, options, tab as Tab));
      return;
    }
    if (window) {
      getCurWnd(false, function ({ state }): void {
        return makeWindow({ url, focused: active },
          state !== "minimized" && state !== "docked" ? state : "");
      });
      return;
    }
    return openMultiTab({
      url, active, windowId: tab ? tab.windowId : undefined,
      openerTabId: options.opener && tab ? tab.id : undefined,
      index: tab ? newTabIndex(tab, options.position) : undefined
    }, cRepeat);
  }
  function openJSUrl(url: string): void {
    if (";".indexOf(url.substring(11).trim()) >= 0) {
      return;
    }
    if (cPort) {
      if (safePost(cPort, { N: kBgReq.eval, u: url })) {
        return;
      }
      cPort = null as never;
    }
    const callback1 = function (opt?: object | -1): void {
      if (opt !== -1 && !onRuntimeError()) { return; }
      const code = Utils.DecodeURLPart_(url.substring(11));
      chrome.tabs.executeScript({ code }, onRuntimeError);
      return onRuntimeError();
    };
    // e.g.: use Chrome omnibox at once on starting
    if (Build.MinCVer < BrowserVer.Min$Tabs$$Update$DoesNotAcceptJavaScriptURLs && Build.BTypes & BrowserType.Chrome &&
        ChromeVer < BrowserVer.Min$Tabs$$Update$DoesNotAcceptJavaScriptURLs) {
      chrome.tabs.update({ url }, callback1);
    } else {
      callback1(-1);
    }
  }
  const
  openShowPage = [function (url, reuse, options, tab): boolean {
    const prefix = Settings.CONST_.ShowPage_;
    if (!url.startsWith(prefix) || url.length < prefix.length + 3) { return false; }
    if (!tab) {
      getCurTab(function (tabs: [Tab]): void {
        if (!tabs || tabs.length <= 0) { return onRuntimeError(); }
        openShowPage[0](url, reuse, options, tabs[0]);
      });
      return true;
    }
    const { incognito } = tab;
    url = url.substring(prefix.length);
    const arr: ShowPageData = [url, null, 0];
    Settings.temp_.shownHash_ = arr[1] = function (this: void) {
      clearTimeout(arr[2]);
      Settings.temp_.shownHash_ = null;
      return arr[0];
    };
    arr[2] = setTimeout(openShowPage[1], 1200, arr);
    if (reuse === ReuseType.current && !incognito) {
      let views = Build.BTypes & BrowserType.Chrome
            && (!(Build.BTypes & ~BrowserType.Chrome) || OnOther === BrowserType.Chrome)
            && !tab.url.split("#", 2)[1] && (
          Build.MinCVer >= BrowserVer.Min$Extension$$GetView$AcceptsTabId ||
          ChromeVer >= BrowserVer.Min$Extension$$GetView$AcceptsTabId)
        ? chrome.extension.getViews({ tabId: tab.id }) : [];
      if (Build.BTypes & BrowserType.Chrome && views.length > 0 && views[0].onhashchange) {
        (views[0].onhashchange as () => void)();
      } else {
        chrome.tabs.update(tab.id, { url: prefix });
      }
    } else {
      tabsCreate({
        active: reuse !== ReuseType.newBg,
        index: incognito ? undefined : newTabIndex(tab, options.position),
        windowId: incognito ? undefined : tab.windowId,
        openerTabId: !incognito && options.opener ? tab.id : undefined,
        url: prefix
      });
    }
    return true;
  }, function (arr) {
    arr[0] = "#!url vimium://error (vimium://show: sorry, the info has expired.)";
    arr[2] = setTimeout(function () {
      if (Settings.temp_.shownHash_ === arr[1]) { Settings.temp_.shownHash_ = null; }
      arr[0] = "", arr[1] = null;
    }, 2000);
  }] as [
    (url: string, reuse: ReuseType, options: Pick<OpenUrlOptions, "position" | "opener">, tab?: Tab) => boolean,
    (arr: ShowPageData) => void
  ];
  // use Urls.WorkType.Default
  function openUrls(tabs: [Tab]): void {
    const tab = tabs[0], { windowId } = tab;
    let urls: string[] = cOptions.urls, repeat = cRepeat;
    for (let i = 0; i < urls.length; i++) {
      urls[i] = Utils.convertToUrl_(urls[i] + "");
    }
    tab.active = !(cOptions.reuse < ReuseType.newFg);
    cOptions = null as never;
    do {
      for (let i = 0, index = tab.index + 1, { active } = tab; i < urls.length; i++, active = false, index++) {
        tabsCreate({ url: urls[i], index, windowId, active });
      }
    } while (0 < --repeat);
  }
  function removeAllTabsInWnd(this: void, tab: Tab, curTabs: Tab[], wnds: Window[]): void {
    let url = false, windowId: number | undefined, wnd: Window;
    wnds = wnds.filter(wnd2 => wnd2.type === "normal");
    if (wnds.length <= 1) {
      // protect the last window
      url = true;
      if (!(wnd = wnds[0])) { /* empty */ }
      else if (wnd.id !== tab.windowId) { url = false; } // the tab may be in a popup window
      else if (wnd.incognito && !Utils.isRefusingIncognito_(Settings.cache_.newTabUrl_f)) {
        windowId = wnd.id;
      }
      // other urls will be disabled if incognito else auto in current window
    }
    else if (!tab.incognito) {
      // protect the only "normal & not incognito" window if it has currentTab
      wnds = wnds.filter(wnd2 => !wnd2.incognito);
      if (wnds.length === 1 && wnds[0].id === tab.windowId) {
        windowId = wnds[0].id;
        url = true;
      }
    }
    if (url) {
      tabsCreate({ index: curTabs.length, url: Settings.cache_.newTabUrl_f, windowId });
    }
    removeTabsInOrder(tab, curTabs, 0, curTabs.length);
  }
  function removeTabsInOrder(tab: Tab, tabs: Tab[], start: number, end: number): void {
    const browserTabs = chrome.tabs, i = tab.index;
    browserTabs.remove(tab.id, onRuntimeError);
    let parts1 = tabs.slice(i + 1, end), parts2 = tabs.slice(start, i);
    if (cRepeat < 0) {
      let tmp = parts1;
      parts1 = parts2;
      parts2 = tmp;
    }
    parts1.length > 0 && browserTabs.remove(parts1.map(j => j.id), onRuntimeError);
    parts2.length > 0 && browserTabs.remove(parts2.map(j => j.id), onRuntimeError);
  }
  /** if `alsoWnd`, then it's safe when tab does not exist */
  function selectTab(this: void, tabId: number, alsoWnd?: boolean): void {
    chrome.tabs.update(tabId, {active: true}, alsoWnd ? selectWnd : null);
  }
  function selectWnd(this: void, tab?: { windowId: number }): void {
    tab && chrome.windows.update(tab.windowId, { focused: true });
    return onRuntimeError();
  }
  /** `direction` is treated as limited; limited by pinned */
  function removeTabsRelative(activeTab: {index: number, pinned: boolean}, direction: number, tabs: Tab[]): void {
    let i = activeTab.index, noPinned = false;
    if (direction > 0) {
      ++i;
      tabs = tabs.slice(i, i + direction);
    } else {
      noPinned = i > 0 && tabs[0].pinned && !tabs[i - 1].pinned;
      if (direction < 0) {
        tabs = tabs.slice(Math.max(i + direction, 0), i);
      } else {
        tabs.splice(i, 1);
      }
    }
    if (noPinned) {
      tabs = tabs.filter(tab => !tab.pinned);
    }
    if (tabs.length > 0) {
      chrome.tabs.remove(tabs.map(tab => tab.id), onRuntimeError);
    }
  }
  /** safe when cPort is null */
  const
  focusOrLaunch = [function (tabs): void {
    if (TabRecency_.incognito_ !== IncognitoType.true) {
      tabs && (tabs = tabs.filter(tab => !tab.incognito));
    }
    if (tabs && tabs.length > 0) {
      getCurWnd(false, focusOrLaunch[2].bind(this, tabs));
      return;
    }
    getCurTab(focusOrLaunch[1].bind(this));
    return onRuntimeError();
  }, function (tabs) {
    // if `this.s`, then `typeof this` is `MarksNS.MarkToGo`
    const callback = this.s ? focusOrLaunch[3].bind(this, 0) : null;
    if (tabs.length <= 0 || TabRecency_.incognito_ === IncognitoType.true && !tabs[0].incognito) {
      chrome.windows.create({url: this.u}, callback && function (wnd: Window): void {
        if (wnd.tabs && wnd.tabs.length > 0) { return callback(wnd.tabs[0]); }
      });
      return;
    }
    tabsCreate({
      index: tabs[0].index + 1,
      url: this.u,
      windowId: tabs[0].windowId
    }, callback);
  }, function (tabs, wnd): void {
    const wndId = wnd.id, url = this.u;
    let tabs2 = tabs.filter(tab2 => tab2.windowId === wndId);
    if (tabs2.length <= 0) {
      tabs2 = wnd.incognito ? tabs : tabs.filter(tab2 => !tab2.incognito);
      if (tabs2.length <= 0) {
        getCurTab(focusOrLaunch[1].bind(this));
        return;
      }
    }
    this.p && tabs2.sort((a, b) => a.url.length - b.url.length);
    let tab: Tab = selectFrom(tabs2);
    if (tab.url.length > tabs2[0].url.length) { tab = tabs2[0]; }
    chrome.tabs.update(tab.id, {
      url: tab.url === url || tab.url.startsWith(url) ? undefined : url,
      active: true
    }, this.s ? focusOrLaunch[3].bind(this, 0) : null);
    if (tab.windowId !== wndId) { return selectWnd(tab); }
  }, function (this: MarksNS.MarkToGo, tick: 0 | 1 | 2, tab: Tab): void {
    if (!tab) { return onRuntimeError(); }
    if (tab.status === "complete" || tick >= 2) {
      return Marks_.scrollTab_(this, tab);
    }
    setTimeout(() => { chrome.tabs.get(tab.id, focusOrLaunch[3].bind(this, tick + 1)); }, 800);
  }] as [
    (this: MarksNS.FocusOrLaunch, tabs: Tab[]) => void,
    (this: MarksNS.FocusOrLaunch, tabs: [Tab] | never[]) => void,
    (this: MarksNS.FocusOrLaunch, tabs: Tab[], wnd: Window) => void,
    (this: MarksNS.MarkToGo, tick: 0 | 1 | 2, tabs: Tab | undefined) => void
  ];
  function gotoMainFrame(req: FgReq[kFgReq.gotoMainFrame], port: Port, mainPort: Port | null) {
    const opt = req.a || {};
    if (mainPort) {
      mainPort.postMessage({
        N: kBgReq.focusFrame,
        S: ensureInnerCSS(port),
        k: VKeyCodes.None,
        m: FrameMaskType.ForcedSelf
      });
    } else {
      opt.$forced = true;
    }
    (mainPort || port).postMessage({
      N: kBgReq.execute,
      S: null,
      c: req.c, n: req.n,
      a: opt
    });
  }
  function executeShortcut(cmd: kShortcutNames, ports: Frames.Frames | null | undefined): void {
    if (gCmdTimer) {
      clearTimeout(gCmdTimer);
      gCmdTimer = 0;
    }
    if (!ports) {
      return executeCommand(CommandsData_.shortcutMap_[cmd], 1, VKeyCodes.None, null as never as Port);
    }
    gCmdTimer = setTimeout(executeShortcut, 100, cmd, null);
    ports[0].postMessage({ N: kBgReq.count, c: cmd, i: gCmdTimer });
  }
  const
  BgCmdInfo: { [K in kBgCmd & number]: K extends keyof BgCmdInfoNS ? BgCmdInfoNS[K] : UseTab.NoTab; } = [
    UseTab.NoTab,
    Build.MinCVer < BrowserVer.MinNoUnmatchedIncognito && Build.BTypes & BrowserType.Chrome
      ? UseTab.NoTab : UseTab.ActiveTab,
    UseTab.NoTab, UseTab.NoTab, UseTab.ActiveTab, UseTab.ActiveTab,
    UseTab.NoTab, UseTab.CurShownTabs, UseTab.CurWndTabs, UseTab.CurWndTabs, UseTab.CurWndTabs,
    UseTab.NoTab, UseTab.NoTab, UseTab.NoTab, UseTab.NoTab, UseTab.ActiveTab,
    UseTab.CurWndTabs, UseTab.NoTab, UseTab.CurWndTabs, UseTab.NoTab, UseTab.ActiveTab,
    UseTab.ActiveTab, UseTab.NoTab, UseTab.CurWndTabs, UseTab.NoTab, UseTab.NoTab,
    UseTab.NoTab, UseTab.CurWndTabs, UseTab.ActiveTab, UseTab.NoTab, UseTab.NoTab,
    UseTab.NoTab, UseTab.NoTab, UseTab.NoTab, UseTab.NoTab, UseTab.NoTab,
    UseTab.ActiveTab, UseTab.NoTab, UseTab.NoTab, UseTab.ActiveTab
  ],
  BackgroundCommands: {
    [K in kBgCmd & number]:
      K extends keyof BgCmdInfoNS ?
        BgCmdInfoNS[K] extends UseTab.ActiveTab ? BgCmdActiveTab :
        BgCmdInfoNS[K] extends UseTab.CurWndTabs ? BgCmdCurWndTabs :
        BgCmdInfoNS[K] extends UseTab.CurShownTabs ? BgCmdCurWndTabs :
        BgCmdInfoNS[K] extends UseTab.ActiveTab | UseTab.NoTab ? BgCmdActiveTabOrNoTab :
        never :
      BgCmdNoTab;
  } = [
    /* kBgCmd.goBack: */ !(Build.BTypes & ~BrowserType.Chrome) && Build.MinCVer >= BrowserVer.Min$Tabs$$goBack
          || (Build.BTypes & ~BrowserType.Firefox || Build.DetectAPIOnFirefox) && chrome.tabs.goBack
        ? function (this: void): void {
      const tabID = TabRecency_.last_ < 0 ? null as never : TabRecency_.last_, count = cRepeat,
      jump = (count > 0 ? chrome.tabs.goBack : chrome.tabs.goForward) as NonNullable<typeof chrome.tabs.goBack>;
      for (let i = 0, end = count > 0 ? count : -count; i < end; i++) {
        jump(tabID, onRuntimeError);
      }
    } : Utils.blank_ as never,
    /* createTab: */ Utils.blank_,
    /* duplicateTab: */ function (): void {
      const tabId = cPort.s.t;
      if (tabId < 0) {
        return Backend.complain_("duplicate such a tab");
      }
      chrome.tabs.duplicate(tabId);
      if (cRepeat < 2) { return; }
      if (Build.MinCVer >= BrowserVer.MinNoUnmatchedIncognito || !(Build.BTypes & BrowserType.Chrome)
          || ChromeVer >= BrowserVer.MinNoUnmatchedIncognito
          || TabRecency_.incognito_ === IncognitoType.ensuredFalse
          || Settings.CONST_.DisallowIncognito_
          ) {
        chrome.tabs.get(tabId, fallback);
      } else {
        chrome.windows.getCurrent({populate: true}, function (wnd: PopWindow): void {
          const tab = wnd.tabs.filter(tab2 => tab2.id === tabId)[0];
          if (!wnd.incognito || tab.incognito) {
            return fallback(tab);
          }
          for (let count = cRepeat; 0 < --count; ) {
            chrome.tabs.duplicate(tabId);
          }
        });
      }
      function fallback(tab: Tab): void {
        return openMultiTab({
          url: tab.url, active: false, windowId: tab.windowId,
          pinned: tab.pinned,
          index: tab.index + 2 , openerTabId: tab.id
        }, cRepeat - 1);
      }
    },
    /* moveTabToNewWindow: */ function (): void {
      const incognito = !!cOptions.incognito;
      if (incognito && (cPort ? cPort.s.a : TabRecency_.incognito_ === IncognitoType.true)) {
        return reportNoop();
      }
      chrome.windows.getCurrent({populate: true}, incognito ? moveTabToIncognito : moveTabToNewWindow0);
      function moveTabToNewWindow0(this: void, wnd: PopWindow): void {
        const tabs0 = wnd.tabs, total = tabs0.length;
        if (total <= 1) { return; } // not need to show a tip
        const tab = selectFrom(tabs0), i = tab.index,
        range = getTabRange(i, total),
        count = range[1] - range[0];
        if (count >= total) { return Backend.showHUD_("It does nothing to move all tabs of this window"); }
        if (count > 30 && !confirm("moveTabToNewWindow", count)) { return; }
        return makeWindow({
          tabId: tab.id,
          incognito: tab.incognito
        }, wnd.type === "normal" ? wnd.state : "", count > 1 ?
        function (wnd2: Window): void {
          let curTab = tabs0[i], tabs = tabs0.slice(i + 1, range[1]), tabs2 = tabs0.slice(range[0], i);
          if (Build.MinCVer < BrowserVer.MinNoUnmatchedIncognito
              && Build.BTypes & BrowserType.Chrome
              && wnd.incognito && ChromeVer < BrowserVer.MinNoUnmatchedIncognito) {
            let { incognito: incognito2 } = curTab, filter = (tab2: Tab): boolean => tab2.incognito === incognito2;
            tabs = tabs.filter(filter);
            tabs2 = tabs2.filter(filter);
          }
          let curInd = 0;
          const getId = (tab2: Tab): number => tab2.id;
          if (tabs2 && tabs2.length > 0) {
            chrome.tabs.move(tabs2.map(getId), {index: 0, windowId: wnd2.id}, onRuntimeError);
            curInd = tabs2.length;
            if (curInd > 1) { // Chrome only accepts the first two tabs of tabs2
              chrome.tabs.move(curTab.id, {index: curInd});
            }
          }
          if (tabs && tabs.length > 0) {
            chrome.tabs.move(tabs.map(getId), {index: curInd + 1, windowId: wnd2.id}, onRuntimeError);
          }
        } : null);
      }
      function reportNoop(): void {
        return Backend.showHUD_("This tab has been in an incognito window");
      }
      function moveTabToIncognito(wnd: PopWindow): void {
        const tab = selectFrom(wnd.tabs);
        if (wnd.incognito && tab.incognito) { return reportNoop(); }
        const options: chrome.windows.CreateData = {tabId: tab.id, incognito: true}, url = tab.url;
        if (tab.incognito) { /* empty */ }
        else if (Build.MinCVer < BrowserVer.MinNoUnmatchedIncognito && Build.BTypes & BrowserType.Chrome
            && wnd.incognito) {
          if (Utils.isRefusingIncognito_(url)) {
            return reportNoop();
          }
          ++tab.index;
          return Backend.reopenTab_(tab);
        } else if (Utils.isRefusingIncognito_(url)) {
          if (Build.MinCVer >= BrowserVer.MinNoUnmatchedIncognito || !(Build.BTypes & BrowserType.Chrome) ||
              ChromeVer >= BrowserVer.MinNoUnmatchedIncognito || Settings.CONST_.DisallowIncognito_) {
            return Backend.complain_("open this URL in incognito mode");
          }
        } else {
          options.url = url;
        }
        (wnd as Window).tabs = undefined;
        chrome.windows.getAll(function (wnds): void {
          let tabId: number | undefined;
          wnds = wnds.filter((wnd2: Window): wnd2 is IncNormalWnd => {
            return wnd2.incognito && wnd2.type === "normal";
          });
          if (wnds.length) {
            chrome.tabs.query({ windowId: wnds[wnds.length - 1].id, active: true }, function ([tab2]): void {
              const tabId2 = options.tabId as number;
              if (Build.MinCVer >= BrowserVer.MinNoUnmatchedIncognito || !(Build.BTypes & BrowserType.Chrome)
                  || options.url) {
                chrome.tabs.create({url: options.url, index: tab2.index + 1, windowId: tab2.windowId});
                selectWnd(tab2);
                chrome.tabs.remove(tabId2);
              } else {
                makeTempWindow(tabId2, true, function (): void {
                  chrome.tabs.move(tabId2, {index: tab2.index + 1, windowId: tab2.windowId}, function (): void {
                    return selectTab(tabId2, true);
                  });
                });
              }
            });
            return;
          }
          let state: chrome.windows.ValidStates | "" = wnd.type === "normal" ? wnd.state : "";
          if (options.url) {
            tabId = options.tabId;
            options.tabId = undefined;
            if (Settings.CONST_.DisallowIncognito_) {
              options.focused = true;
              state = "";
            }
          }
          // in tests on Chrome 46/51, Chrome hangs at once after creating a new normal window from an incognito tab
          // so there's no need to worry about stranger edge cases like "normal window + incognito tab + not allowed"
          makeWindow(options, state);
          if (tabId != null) {
            chrome.tabs.remove(tabId);
          }
        });
      }
    },
    /* moveTabToNextWindow: */ function (this: void, [tab]: [Tab]): void {
      chrome.windows.getAll(function (wnds0: Window[]): void {
        let wnds: Window[], ids: number[], index = tab.windowId;
        wnds = wnds0.filter(wnd => wnd.incognito === tab.incognito && wnd.type === "normal");
        if (wnds.length > 0) {
          ids = wnds.map(wnd => wnd.id);
          index = ids.indexOf(index);
          if (ids.length >= 2 || index < 0) {
            let dest = (index + cRepeat) % ids.length;
            index < 0 && cRepeat < 0 && dest++;
            dest < 0 && (dest += ids.length);
            chrome.tabs.query({windowId: ids[dest], active: true}, function ([tab2]): void {
              Build.MinCVer >= BrowserVer.MinNoUnmatchedIncognito || !(Build.BTypes & BrowserType.Chrome)
              ? chrome.tabs.move(tab.id, {
                index: tab2.index + (cOptions.right > 0 ? 1 : 0), windowId: tab2.windowId
              }, function (): void {
                return selectTab(tab.id, true);
              })
              : index >= 0 || ChromeVer >= BrowserVer.MinNoUnmatchedIncognito ? callback()
              : makeTempWindow(tab.id, tab.incognito, callback);
              function callback(): void {
                chrome.tabs.move(tab.id, {
                  index: tab2.index + (cOptions.right > 0 ? 1 : 0), windowId: tab2.windowId
                }, function (): void {
                  return selectTab(tab.id, true);
                });
              }
            });
            return;
          }
        } else {
          wnds = wnds0.filter(wnd => wnd.id === index);
        }
        return makeWindow({
          tabId: tab.id,
          incognito: tab.incognito
        }, wnds.length === 1 && wnds[0].type === "normal" ? wnds[0].state : "");
      });
    },
    /* toggleCS: */ function (this: void, tabs: [Tab]): void {
      if (!Build.PContentSettings) {
        (ContentSettings_.complain_ as () => any)();
        return;
      }
      return ContentSettings_.toggleCS_(cRepeat, cOptions, tabs);
    },
    /* clearCS: */ function (this: void): void {
      if (!Build.PContentSettings) {
        (ContentSettings_.complain_ as () => any)();
        return;
      }
      return ContentSettings_.clearCS_(cOptions, cPort);
    },
    /* goTab: */ function (this: void, tabs: Tab[]): void {
      if (tabs.length < 2) { return; }
      const count = ((cOptions.dir | 0) || 1) * cRepeat, len = tabs.length;
      let cur: Tab | undefined, index = cOptions.absolute
        ? count > 0 ? Math.min(len, count) - 1 : Math.max(0, len + count)
        : Math.abs(count) > tabs.length * 2 ? (count > 0 ? -1 : 0)
        : (cur = selectFrom(tabs, 1)).index + count;
      index = (index >= 0 ? 0 : len) + (index % len);
      let toSelect: Tab = tabs[index];
      if (toSelect.pinned && count < 0 && cOptions.noPinned) {
        let curIndex = (cur || selectFrom(tabs, 1)).index;
        if (curIndex > index && !tabs[curIndex - 1].pinned) {
          while (tabs[index].pinned) { index++; }
          toSelect = tabs[index];
        }
      }
      if (!toSelect.active) { return selectTab(toSelect.id); }
    },
    /* removeTab: */ function (this: void, tabs: Tab[]): void {
      if (!tabs || tabs.length <= 0) { return onRuntimeError(); }
      const total = tabs.length, tab = selectFrom(tabs), i = tab.index;
      let count = 1, start = i, end = i + 1;
      if (Math.abs(cRepeat) > 1 && total > 1) {
        const noPinned = tabs[0].pinned !== tab.pinned && !(cRepeat < 0 && tabs[i - 1].pinned);
        let skipped = 0;
        if (noPinned) {
          while (tabs[skipped].pinned) { skipped++; }
        }
        const range = getTabRange(i, total - skipped, total);
        start = skipped + range[0], end = skipped + range[1];
        count = end - start;
        if (count > 20 && !confirm("removeTab", count)) {
          return;
        }
      }
      if (count >= total && cOptions.allow_close !== true) {
        chrome.windows.getAll(removeAllTabsInWnd.bind(null, tab, tabs));
        return;
      }
      removeTabsInOrder(tab, tabs, start, end);
      if (start > 0 && cOptions.left) {
        // note: here not wait real removing, otherwise the browser window may flicker
        chrome.tabs.update(tabs[start - 1].id, { active: true });
      }
    },
    /* removeTabsR: */ function (this: void, tabs: Tab[]): void {
      let dir = cOptions.dir | 0;
      dir = dir > 0 ? 1 : dir < 0 ? -1 : 0;
      return removeTabsRelative(selectFrom(tabs), dir * cRepeat, tabs);
    },
    /* removeRightTab: */ function (this: void, tabs: Tab[]): void {
      if (!tabs) { return; }
      const ind = selectFrom(tabs).index, [start, end] = getTabRange(ind, tabs.length, 0, 1);
      chrome.tabs.remove(tabs[ind + 1 === end || cRepeat > 0 && start !== ind ? start : end - 1].id);
    },
    /* restoreTab: */ function (this: void): void {
      if (!chrome.sessions) {
        return complainNoSession();
      }
      let count = cRepeat;
      if (count < 2 && count > -2 && cPort.s.a) {
        return Backend.showHUD_("Can not restore a tab in incognito mode!");
      }
      const limit = (chrome.sessions.MAX_SESSION_RESULTS as number) | 0;
      count > limit && limit > 0 && (count = limit);
      do {
        chrome.sessions.restore(null, onRuntimeError);
      } while (0 < --count);
    },
    /* restoreGivenTab: */ function (): void {
      if (!chrome.sessions) {
        return complainNoSession();
      }
      function doRestore(this: void, list: chrome.sessions.Session[]): void {
        if (cRepeat > list.length) {
          return Backend.showHUD_("The session index provided is out of range.");
        }
        const session = list[cRepeat - 1], item = session.tab || session.window;
        item && chrome.sessions.restore(item.sessionId);
      }
      if (cRepeat > (chrome.sessions.MAX_SESSION_RESULTS || 25)) {
        return doRestore([]);
      }
      if (cRepeat <= 1) {
        chrome.sessions.restore(null, onRuntimeError);
        return;
      }
      chrome.sessions.getRecentlyClosed(doRestore);
    },
    /* blank: */ Utils.blank_
    ,
    /* openUrl: */ function (this: void, tabs?: [Tab] | never[]): void {
      if (cOptions.urls) {
        if (!(cOptions.urls instanceof Array)) { cOptions = null as never; return; }
        return tabs && tabs.length > 0 ? openUrls(tabs as [Tab]) : void getCurTab(openUrls);
      }
      if (cOptions.url_mask && !tabs) {
        return onRuntimeError() || <any> void getCurTab(BackgroundCommands[kBgCmd.openUrl]);
      }
      if (cOptions.url) {
        openUrl(cOptions.url + "", Urls.WorkType.ActAnyway, tabs);
      } else if (cOptions.copied) {
        const url = Clipboard_.paste_();
        if (url instanceof Promise) {
          url.then(openCopiedUrl.bind(null, tabs), openCopiedUrl.bind(null, null as never, null));
          return;
        }
        openCopiedUrl(tabs, url);
      } else {
        openUrl((cOptions.url_f as Urls.Url) || "", Urls.WorkType.FakeType, tabs);
      }
    },
    /* searchInAnother: */ function (this: void, tabs: [Tab]): void {
      let keyword = (cOptions.keyword || "") + "";
      const query = Backend.parse_({ u: tabs[0].url });
      if (!query || !keyword) {
        Backend.showHUD_(keyword ? "No search engine found!"
          : 'This key mapping lacks an arg "keyword"');
        return;
      }
      let url_f = Utils.createSearchUrl_(query.u.split(" "), keyword, Urls.WorkType.ActAnyway);
      cOptions = Object.setPrototypeOf({
        reuse: cOptions.reuse | 0,
        opener: true,
        url_f
      }, null);
      BackgroundCommands[kBgCmd.openUrl](tabs);
    },
    /* togglePinTab: */ function (this: void, tabs: Tab[]): void {
      const tab = selectFrom(tabs), pin = !tab.pinned, action = {pinned: pin}, offset = pin ? 0 : 1;
      let skipped = 0;
      if (Math.abs(cRepeat) > 1 && pin) {
        while (tabs[skipped].pinned) { skipped++; }
      }
      const range = getTabRange(tab.index, tabs.length - skipped, tabs.length);
      let start = skipped + range[offset] - offset, end = skipped + range[1 - offset] - offset;
      const wantedTabIds = [] as number[];
      for (; start !== end; start += pin ? 1 : -1) {
        if (pin || tabs[start].pinned) {
          wantedTabIds.push(tabs[start].id);
        }
      }
      end = wantedTabIds.length;
      if (end > 30 && !confirm("togglePinTab", end)) {
        return;
      }
      for (start = 0; start < end; start++) {
        chrome.tabs.update(wantedTabIds[start], action);
      }
    },
    /* toggleMuteTab: */ function (): void {
      if (!(Build.BTypes & ~BrowserType.Edge)
          || (Build.BTypes & BrowserType.Edge && OnOther === BrowserType.Edge)
          || Build.MinCVer < BrowserVer.MinMuted && Build.BTypes & BrowserType.Chrome
              && ChromeVer < BrowserVer.MinMuted) {
        return Backend.showHUD_(`Vimium C can not control mute state before Chrome ${BrowserVer.MinMuted}`);
      }
      if (!(cOptions.all || cOptions.other)) {
        getCurTab(function ([tab]: [Tab]): void {
          const wanted = !tab.mutedInfo.muted;
          chrome.tabs.update(tab.id, { muted: wanted });
          Backend.showHUD_(wanted ? "Muted." : "Unmuted.");
        });
        return;
      }
      chrome.tabs.query({audible: true}, function (tabs: Tab[]): void {
        let curId = cOptions.other ? cPort.s.t : GlobalConsts.TabIdNone
          , prefix = curId === GlobalConsts.TabIdNone ? "All" : "Other"
          , muted = false, action = { muted: true };
        for (let i = tabs.length; 0 <= --i; ) {
          const tab = tabs[i];
          if (tab.id !== curId && !tab.mutedInfo.muted) {
            muted = true;
            chrome.tabs.update(tab.id, action);
          }
        }
        if (muted) { return Backend.showHUD_(prefix + " tabs get muted."); }
        action.muted = false;
        for (let i = tabs.length; 0 <= --i; ) {
          const j = tabs[i].id;
          j !== curId && chrome.tabs.update(j, action);
        }
        Backend.showHUD_(prefix + " tabs are unmuted.");
      });
    },
    /* reloadTab: */ function (this: void, tabs: Tab[] | never[]): void {
      if (tabs.length <= 0) {
        getCurWnd(true, function (wnd) {
          if (!wnd) { return onRuntimeError(); }
          wnd.tabs.length > 0 && BackgroundCommands[kBgCmd.reloadTab](wnd.tabs);
        });
        return;
      }
      let reloadProperties = { bypassCache: (cOptions.hard || cOptions.bypassCache) === true }
        , ind = selectFrom(tabs).index
        , [start, end] = getTabRange(ind, tabs.length);
      if (cOptions.single) {
        ind = ind + 1 === end || cRepeat > 0 && start !== ind ? start : end - 1;
        start = ind; end = ind + 1;
      }
      const count = end - start;
      if (count > 20 && !confirm("reloadTab", count)) {
        return;
      }
      chrome.tabs.reload(tabs[ind].id, reloadProperties);
      for (; start !== end; start++) {
        start !== ind && chrome.tabs.reload(tabs[start].id, reloadProperties);
      }
    },
    /* reloadGivenTab: */ function (): void {
      if (cRepeat < 2 && cRepeat > -2) {
        let reloadProperties = { bypassCache: (cOptions.hard || cOptions.bypassCache) === true };
        chrome.tabs.reload(reloadProperties);
        return;
      }
      getCurTabs(BackgroundCommands[kBgCmd.reloadTab]);
    },
    /* reopenTab: */ function (this: void, tabs: [Tab] | never[]): void {
      if (tabs.length <= 0) { return; }
      const tab = tabs[0];
      ++tab.index;
      if (Build.MinCVer >= BrowserVer.MinNoUnmatchedIncognito || !(Build.BTypes & BrowserType.Chrome)
          || ChromeVer >= BrowserVer.MinNoUnmatchedIncognito
          || TabRecency_.incognito_ === IncognitoType.ensuredFalse
          || Settings.CONST_.DisallowIncognito_
          || !Utils.isRefusingIncognito_(tab.url)) {
        return Backend.reopenTab_(tab);
      }
      chrome.windows.get(tab.windowId, function (wnd): void {
        if (wnd.incognito && !tab.incognito) {
          (tab as ReopenOptions).openerTabId = (tab as ReopenOptions).windowId = undefined;
        }
        return Backend.reopenTab_(tab);
      });
    },
    /* goToRoot: */ function (this: void, tabs: [Tab]): void {
      const trail = cOptions.trailing_slash,
      { p: path, u: url } = requestHandlers[kFgReq.parseUpperUrl]({
        t: trail != null ? !!trail : null,
        u: tabs[0].url, p: cRepeat
      });
      if (path != null) {
        chrome.tabs.update(tabs[0].id, {url});
        return;
      }
      return Backend.showHUD_(url);
    },
    /* goUp: */ function (this: void): void {
      const trail = cOptions.trailing_slash;
      requireURL({
        H: kFgReq.parseUpperUrl,
        u: "", // just a hack to make TypeScript compiler happy
        p: -cRepeat,
        t: trail != null ? !!trail : null,
        e: true
      });
    },
    /* moveTab: */ function (this: void, tabs: Tab[]): void {
      const tab = selectFrom(tabs), dir = cOptions.dir > 0 ? 1 : -1, pinned = tab.pinned;
      let index = Math.max(0, Math.min(tabs.length - 1, tab.index + dir * cRepeat));
      while (pinned !== tabs[index].pinned) { index -= dir; }
      if (index !== tab.index) {
        chrome.tabs.move(tab.id, { index });
      }
    },
    /* nextFrame: */ function (this: void): void {
      let port = cPort, ind = -1;
      const frames = framesForTab[port.s.t];
      if (frames && frames.length > 2) {
        ind = Math.max(0, frames.indexOf(port, 1));
        for (let count = Math.abs(cRepeat), dir = cRepeat > 0 ? 1 : -1; count > 0; count--) {
          ind += dir;
          if (ind === frames.length) { ind = 1; }
          else if (ind < 1) { ind = frames.length - 1; }
        }
        port = frames[ind];
      }
      port.postMessage({
        N: kBgReq.focusFrame,
        S: port.s.i === 0 ? ensureInnerCSS(port) : null,
        k: cKey,
        m: port !== cPort && frames && port !== frames[0] ? FrameMaskType.NormalNext : FrameMaskType.OnlySelf
      });
    },
    /* mainFrame: */ function (): void {
      const tabId = cPort ? cPort.s.t : TabRecency_.last_, port = indexFrame(tabId, 0);
      if (!port) { return; }
      port.postMessage({
        N: kBgReq.focusFrame,
        S: ensureInnerCSS(port),
        k: cKey,
        m: (framesForTab[tabId] as Frames.Frames)[0] === port ? FrameMaskType.OnlySelf : FrameMaskType.ForcedSelf
      });
    },
    /* parentFrame: */ function (): void {
      const sender = cPort.s as typeof cPort.s | undefined,
      msg = Build.MinCVer < BrowserVer.MinWithFrameId && Build.BTypes & BrowserType.Chrome && NoFrameId
        ? `Vimium C can not know parent frame before Chrome ${BrowserVer.MinWithFrameId}`
        : !(sender && sender.t >= 0 && framesForTab[sender.t])
          ? "Vimium C can not access frames in current tab"
        : null;
      msg && Backend.showHUD_(msg);
      if (!sender || !sender.i
          || Build.MinCVer < BrowserVer.MinWithFrameId && Build.BTypes & BrowserType.Chrome && NoFrameId
          || !chrome.webNavigation) {
        return BackgroundCommands[kBgCmd.mainFrame]();
      }
      chrome.webNavigation.getAllFrames({
        tabId: sender.t
      }, function (frames: chrome.webNavigation.GetAllFrameResultDetails[]): void {
        let frameId = sender.i, found: boolean, count = cRepeat;
        do {
          found = false;
          for (const i of frames) {
            if (i.frameId === frameId) {
              frameId = i.parentFrameId;
              found = frameId > 0;
              break;
            }
          }
        } while (found && 0 < --count);
        const port = frameId > 0 ? indexFrame(sender.t, frameId) : null;
        if (!port) {
          return BackgroundCommands[kBgCmd.mainFrame]();
        }
        port.postMessage({
          N: kBgReq.focusFrame,
          S: ensureInnerCSS(port),
          k: cKey,
          m: FrameMaskType.ForcedSelf
        });
      });
    },
    /* visitPreviousTab: */ function (this: void, tabs: Tab[]): void {
      if (tabs.length < 2) { return; }
      tabs.splice(selectFrom(tabs).index, 1);
      tabs = tabs.filter(i => i.id in TabRecency_.tabs_).sort(TabRecency_.rCompare_);
      const tab = tabs[cRepeat > 0 ? Math.min(cRepeat, tabs.length) - 1
        : Math.max(0, tabs.length + cRepeat)];
      tab && selectTab(tab.id);
    },
    /* copyTabInfo: */ function (this: void, tabs: [Tab]): void {
      let str: string, decoded = !!(cOptions.decoded || cOptions.decode);
      switch (cOptions.type) {
      case "title": str = tabs[0].title; break;
      case "frame":
        if (needIcon && (str = cPort.s.u)) { break; }
        cPort.postMessage<1, kFgCmd.autoCopy>({
          N: kBgReq.execute,
          S: ensureInnerCSS(cPort),
          c: kFgCmd.autoCopy, n: 1,
          a: { url: true, decoded }
        });
        return;
      default: str = tabs[0].url; break;
      }
      decoded && (str = Utils.DecodeURLPart_(str, decodeURI));
      Utils.copy_(str);
      return Backend.showHUD_(str, true);
    },
    /* goNext: */ function (): void {
      let rel: string | undefined = cOptions.rel || cOptions.dir, p2: string[] = []
        , patterns: string | string[] | boolean | number = cOptions.patterns;
      rel = rel ? rel + "" : "next";
      if (patterns instanceof Array) {
        for (let i of patterns) {
          i = i && (i + "").trim();
          i && p2.push(i.toLowerCase());
        }
      } else {
        typeof patterns === "string" || (patterns = "");
        patterns = (patterns as string) || Settings.get_(rel !== "next" ? "previousPatterns" : "nextPatterns", true);
        patterns = patterns.trim().toLowerCase().split(",");
        for (let i of patterns) {
          i = i.trim();
          i && p2.push(i);
        }
      }
      if (p2.length > GlobalConsts.MaxNumberOfNextPatterns) { p2.length = GlobalConsts.MaxNumberOfNextPatterns; }
      cPort.postMessage<1, kFgCmd.goNext>({ N: kBgReq.execute,
        S: null, c: kFgCmd.goNext, n: 1,
        a: {
          rel,
          patterns: p2
        }
      });
    },
    /* enterInsertMode: */ function (): void {
      let code = cOptions.code | 0, stat: KeyStat = cOptions.stat | 0;
      code = stat !== KeyStat.plain ? code || VKeyCodes.esc : code === VKeyCodes.esc ? 0 : code;
      let
      hud = cOptions.hideHUD != null ? !cOptions.hideHUD : cOptions.hideHud != null ? !cOptions.hideHud
        : !Settings.get_("hideHud", true);
      cPort.postMessage<1, kFgCmd.insertMode>({ N: kBgReq.execute,
        S: hud ? ensureInnerCSS(cPort) : null,
        c: kFgCmd.insertMode,
        n: 1,
        a: {
          code, stat,
          passExitKey: !!cOptions.passExitKey,
          hud
        }
      });
    },
    /* enterVisualMode: */ function (): void {
      if (Build.BTypes & BrowserType.Edge && (!(Build.BTypes & ~BrowserType.Edge) || OnOther === BrowserType.Edge)) {
        return Backend.complain_("control selection on MS Edge");
      }
      const flags = cPort.s.f, str = typeof cOptions.mode === "string" ? (cOptions.mode as string).toLowerCase() : "";
      let words = "";
      if (Build.BTypes & BrowserType.Firefox && !Build.NativeWordMoveOnFirefox
        || Build.BTypes & ~BrowserType.Firefox && Build.MinCVer < BrowserVer.MinEnsuredUnicodePropertyEscapesInRegExp
          && Build.MinCVer < BrowserVer.MinSelExtendForwardOnlySkipWhitespaces
      ) {
        if (~flags & Frames.Flags.hadVisualMode) {
          words = Settings.CONST_.words;
          cPort.s.f = Frames.Flags.hadVisualMode | flags;
        }
      }
      cPort.postMessage<1, kFgCmd.visualMode>({ N: kBgReq.execute,
        S: ensureInnerCSS(cPort), c: kFgCmd.visualMode, n: 1,
        a: {
          m: (str === "caret" ? VisualModeNS.Mode.Caret
              : str === "line" ? VisualModeNS.Mode.Line : VisualModeNS.Mode.Visual
            ) as VisualModeNS.Mode.Visual | VisualModeNS.Mode.Line | VisualModeNS.Mode.Caret,
          w: words,
        }
      });
    },
    /* performFind: */ function (): void {
      const sender = cPort.s, absRepeat = cRepeat < 0 ? -cRepeat : cRepeat, rawIndex = cOptions.index,
      nth = rawIndex ? rawIndex === "other" ? absRepeat + 1 : rawIndex === "count" ? absRepeat
                : rawIndex >= 0 ? -1 - (0 | rawIndex) : 0 : 0,
      leave = !!nth || !cOptions.active;
      let findCSS: CmdOptions[kFgCmd.findMode]["f"] = null;
      if (!(sender.f & Frames.Flags.hasFindCSS)) {
        sender.f |= Frames.Flags.hasFindCSS;
        findCSS = Settings.cache_.findCSS_;
      }
      cPort.postMessage<1, kFgCmd.findMode>({ N: kBgReq.execute
          , S: ensureInnerCSS(cPort), c: kFgCmd.findMode, n: 1
          , a: {
        n: nth > 0 ? cRepeat < 0 ? -1 : 1 : cOptions.dir <= 0 ? -cRepeat : cRepeat,
        l: leave,
        f: findCSS,
        r: cOptions.returnToViewport === true,
        q: leave || cOptions.last ? FindModeHistory_.query_(sender.a, "", nth < 0 ? -nth : nth) : ""
      }});
    },
    /* showVomnibar: */ function (this: void, forceInner?: boolean): void {
      let port = cPort as Port | null, optUrl: VomnibarNS.GlobalOptions["url"] = cOptions.url;
      if (optUrl != null && optUrl !== true && typeof optUrl !== "string") {
        optUrl = null;
        delete (cOptions as {} as VomnibarNS.GlobalOptions).url;
      }
      if (!port) {
        port = cPort = indexFrame(TabRecency_.last_, 0) as Port;
        if (!port) { return; }
      } else if (port.s.i !== 0 && port.s.t >= 0 && /* null | "" */ !optUrl) {
        port = indexFrame(port.s.t, 0) || port;
      }
      const page = Settings.cache_.vomnibarPage_f, { u: url } = port.s, preferWeb = !page.startsWith(BrowserProtocol_),
      inner = forceInner || !page.startsWith(location.origin) ? Settings.CONST_.VomnibarPageInner_ : page;
      forceInner = (preferWeb ? url.startsWith(BrowserProtocol_) || page.startsWith("file:") && !url.startsWith("file:")
          // it has occurred since Chrome 50 (BrowserVer.Min$tabs$$executeScript$hasFrameIdArg)
          // that HTTPS refusing HTTP iframes.
          || page.startsWith("http:") && url.startsWith("https:")
        : port.s.a) || url.startsWith(location.origin) || !!forceInner;
      const useInner: boolean = forceInner || page === inner || port.s.t < 0,
      options: CmdOptions[kFgCmd.vomnibar] & SafeObject = Utils.extendIf_(
          Object.setPrototypeOf<CmdOptions[kFgCmd.vomnibar]>({
        v: useInner ? inner : page,
        i: useInner ? null : inner,
        t: useInner ? VomnibarNS.PageType.inner : preferWeb ? VomnibarNS.PageType.web : VomnibarNS.PageType.ext,
        s: useInner ? "" : Settings.CONST_.VomnibarScript_f_,
        k: getSecret(),
      }, null), cOptions as {} as CmdOptions[kFgCmd.vomnibar]);
      port.postMessage<1, kFgCmd.vomnibar>({
        N: kBgReq.execute, S: ensureInnerCSS(port),
        c: kFgCmd.vomnibar, n: cRepeat,
        a: options
      });
      options.k = -1;
      cOptions = options; // safe on renaming
    },
    /* clearFindHistory: */ function (this: void): void {
      const { a: incognito } = cPort.s;
      FindModeHistory_.removeAll_(incognito);
      return Backend.showHUD_((incognito ? "incognito " : "") + "find history has been cleared.");
    },
    /* showHelp: */ function (this: void): void {
      if (cPort.s.i === 0 && !(cPort.s.f & Frames.Flags.hadHelpDialog)) {
        return requestHandlers[kFgReq.initHelp]({}, cPort);
      }
      if (!window.HelpDialog) {
        Utils.require_("HelpDialog");
      }
      cPort.postMessage<1, kFgCmd.showHelp>({
        N: kBgReq.execute,
        S: null,
        c: kFgCmd.showHelp,
        n: 1,
        a: null
      });
    },
    /* toggleViewSource: */ function (this: void, tabs: [Tab]): void {
      let tab = tabs[0], url = tab.url;
      if (url.startsWith(BrowserProtocol_)) {
        return Backend.complain_("visit HTML of an extension's page");
      }
      url = url.startsWith("view-source:") ? url.substring(12) : ("view-source:" + url);
      tabsCreate({
        url, active: tab.active, windowId: tab.windowId,
        index: tab.index + 1, openerTabId: tab.id
      });
    },
    /* clearMarks: */ function (this: void): void {
      cOptions.local ? requireURL({ H: kFgReq.marks, u: "", a: kMarkAction.clear }, true) : Marks_.clear_();
    },
    /* kBgCmd.toggle: */ function (this: void): void {
      type Keys = CmdOptions[kFgCmd.toggle]["key"];
      const all = Settings.payload_, key: Keys = (cOptions.key || "") + "" as Keys,
      old = all[key], keyRepr = '"' + key + '"';
      let value = cOptions.value, isBool = typeof value === "boolean", msg = "";
      if (Settings.valuesToLoad_.indexOf(key) < 0) {
        msg = key in Settings.defaults_ ? "option " + keyRepr + " is not a valid switch" : "unknown option " + keyRepr;
      } else if (typeof old === "boolean") {
        isBool || (value = null);
      } else if (value === undefined) {
        msg = "need value=... for option " + keyRepr;
      } else if (isBool) {
        msg = keyRepr + " is not a boolean switch";
      } else if (typeof value !== typeof old) {
        msg = JSON.stringify(old);
        msg = "value of " + keyRepr + " should be like " +
          (msg.length > 10 ? msg.substring(0, 9) + "\u2026" : msg);
      }
      if (msg) {
        Backend.showHUD_(msg);
      } else {
        cPort.postMessage<1, kFgCmd.toggle>({
          N: kBgReq.execute,
          S: ensureInnerCSS(cPort),
          c: kFgCmd.toggle, n: 1,
          a: { key, value }
        });
      }
    },
    /* toggleVomnibarStyle: */ function (this: void, tabs: [Tab]): void {
      const tabId = tabs[0].id, toggled = ((cOptions.style || "") + "").trim(), current = !!cOptions.current;
      if (!toggled) {
        return Backend.showHUD_("No style name of Vomnibar is given");
      }
      for (const frame of framesForOmni) {
        if (frame.s.t === tabId) {
          frame.postMessage({ N: kBgReq.omni_toggleStyle, t: toggled, c: current });
          return;
        }
      }
      if (current) { return; }
      const vomnibarOptions = Settings.cache_.vomnibarOptions;
      let toggle = ` ${toggled} `, curStyles = vomnibarOptions.styles && ` ${vomnibarOptions.styles} `;
      requestHandlers[kFgReq.setOmniStyle]({
        s: curStyles.indexOf(toggle) >= 0 ? curStyles.replace(toggle, " ") : curStyles + toggled
      });
    }
  ],
  numHeadRe = <RegExpOne> /^-?\d+|^-/;
  function executeCommand(registryEntry: CommandsNS.Item
      , count: number, lastKey: VKeyCodes, port: Port): void {
    const { options, repeat } = registryEntry;
    let scale: number | undefined;
    if (options && (scale = options.count)) { count = count * scale; }
    count = count >= 1e4 ? 9999 : count <= -1e4 ? 9999 : (count | 0) || 1;
    if (count === 1) { /* empty */ }
    else if (repeat === 1) { count = 1; }
    else if (repeat > 0 && (count > repeat || count < -repeat) && !confirm(registryEntry.command, Math.abs(count))) {
      return;
    }else { count = count || 1; }
    if (!registryEntry.background) {
      const { alias: fgAlias } = registryEntry,
      dot = ((
        (1 << kFgCmd.linkHints) | (1 << kFgCmd.unhoverLast) | (1 << kFgCmd.marks) |
        (1 << kFgCmd.passNextKey) | (1 << kFgCmd.autoCopy) | (1 << kFgCmd.focusInput)
      ) >> fgAlias) & 1;
      port.postMessage({ N: kBgReq.execute, S: dot ? ensureInnerCSS(port) : null, c: fgAlias, n: count, a: options });
      return;
    }
    const { alias } = registryEntry, func = BackgroundCommands[alias];
    // safe on renaming
    cOptions = options || Object.create(null);
    cPort = port;
    cRepeat = count;
    cKey = lastKey;
    count = BgCmdInfo[alias];
    if (count < UseTab.ActiveTab) {
      return (func as BgCmdNoTab)();
    } else if (count === UseTab.ActiveTab) {
      getCurTab(func as BgCmdActiveTab);
    } else if (Build.BTypes & BrowserType.Firefox && count === UseTab.CurShownTabs
        && (!(Build.BTypes & ~BrowserType.Firefox) || OnOther === BrowserType.Firefox)) {
      getCurShownTabs(func as BgCmdCurWndTabs);
    } else {
      getCurTabs(func as BgCmdCurWndTabs);
    }
  }
  const
  requestHandlers: {
    [K in keyof FgReqWithRes | keyof FgReq]:
      K extends keyof SpecialHandlers ? SpecialHandlers[K] :
      K extends keyof FgReqWithRes ? (((this: void, request: FgReqWithRes[K], port: Port) => FgRes[K])
        | (K extends keyof FgReq ? (this: void, request: FgReq[K], port: Port) => void : never)) :
      K extends keyof FgReq ? ((this: void, request: FgReq[K], port: Port) => void) :
      never;
  } = [
    /** setSetting: */ function (this: void, request: SetSettingReq<keyof SettingsNS.FrontUpdateAllowedSettings>
        , port: Port): void {
      const key = request.key;
      if (!(key in Settings.frontUpdateAllowed_)) {
        cPort = port;
        return Backend.complain_(`modify ${key} setting`);
      }
      Settings.set_(key, request.value);
      if (key in Settings.payload_) {
        type CacheValue = SettingsNS.FullCache[keyof SettingsNS.FrontUpdateAllowedSettings];
        (Settings.payload_ as SafeDict<CacheValue>)[key] = Settings.cache_[key];
      }
    },
    /** findQuery: */ function (this: void, request: FgReq[kFgReq.findQuery] | FgReqWithRes[kFgReq.findQuery]
        , port: Port): FgRes[kFgReq.findQuery] | void {
      return FindModeHistory_.query_(port.s.a, request.q, request.i);
    },
    /** parseSearchUrl: */ function (this: void, request: FgReqWithRes[kFgReq.parseSearchUrl]
        , port: Port): FgRes[kFgReq.parseSearchUrl] | void {
      let search = Backend.parse_(request);
      if ("i" in request) {
        port.postMessage({ N: kBgReq.omni_parsed, i: request.i as number, s: search });
      } else {
        return search;
      }
    },
    /** parseUpperUrl: */ function (this: void, request: FgReqWithRes[kFgReq.parseUpperUrl]
        , port?: Port): FgRes[kFgReq.parseUpperUrl] | void {
      if (port && (request as FgReq[kFgReq.parseUpperUrl]).e) {
        const result = requestHandlers[kFgReq.parseUpperUrl](request);
        if (result.p != null) {
          port.postMessage<1, kFgCmd.reload>({ N: kBgReq.execute,
            S: null, c: kFgCmd.reload, n: 1,
            a: { url: result.u } });
          return;
        }
        cPort = port;
        Backend.showHUD_(result.u);
        return;
      }
      let { u: url } = request, url_l = url.toLowerCase();
      if (!Utils.protocolRe_.test(Utils.removeComposedScheme_(url_l))) {
        Utils.resetRe_();
        return { u: "This url has no upper paths", p: null };
      }
      const enc = encodeURIComponent;
      let hash = "", str: string, arr: RegExpExecArray | null, startSlash = false, endSlash = false
        , path: string | null = null, i: number, start = 0, end = 0, decoded = false, arr2: RegExpExecArray | null;
      if (i = url.lastIndexOf("#") + 1) {
        hash = url.substring(i + +(url[i] === "!"));
        str = Utils.DecodeURLPart_(hash);
        i = str.lastIndexOf("/");
        if (i > 0 || (i === 0 && str.length > 1)) {
          decoded = str !== hash;
          const argRe = <RegExpOne> /([^&=]+=)([^&\/=]*\/[^&]*)/;
          arr = argRe.exec(str) || (<RegExpOne> /(^|&)([^&\/=]*\/[^&=]*)(?:&|$)/).exec(str);
          path = arr ? arr[2] : str;
          if (path === "/" || path.indexOf("://") >= 0) { path = null; }
          else if (!arr) { start = 0; }
          else if (!decoded) { start = arr.index + arr[1].length; }
          else {
            str = "https://example.com/";
            str = encodeURI(str + path).substring(str.length);
            i = hash.indexOf(str);
            if (i < 0) {
              i = hash.indexOf(str = enc(path));
            }
            if (i < 0) {
              decoded = false;
              i = hash.indexOf(str = path);
            }
            end = i + str.length;
            if (i < 0 && arr[1] !== "&") {
              i = hash.indexOf(str = arr[1]);
              if (i < 0) {
                decoded = true;
                str = arr[1];
                str = enc(str.substring(0, str.length - 1));
                i = hash.indexOf(str);
              }
              if (i >= 0) {
                i += str.length;
                end = hash.indexOf("&", i) + 1;
              }
            }
            if (i >= 0) {
              start = i;
            } else if (arr2 = argRe.exec(hash)) {
              path = Utils.DecodeURLPart_(arr2[2]);
              start = arr2.index + arr2[1].length;
              end = start + arr2[2].length;
            } else if ((str = arr[1]) !== "&") {
              i = url.length - hash.length;
              hash = str + enc(path);
              url = url.substring(0, i) + hash;
              start = str.length;
              end = 0;
            }
          }
          if (path) {
            i = url.length - hash.length;
            start += i;
            end > 0 && (end += i);
          }
        }
      }
      if (!path) {
        if (url_l.startsWith(BrowserProtocol_)) {
          Utils.resetRe_();
          return { u: "An extension has no upper-level pages", p: null };
        }
        hash = "";
        start = url.indexOf("/", url.indexOf("://") + 3);
        if (url_l.startsWith("filesystem:")) { start = url.indexOf("/", start + 1); }
        i = url.indexOf("?", start);
        end = url.indexOf("#", start);
        i = end < 0 ? i : i < 0 ? end : i < end ? i : end;
        i = i > 0 ? i : url.length;
        path = url.substring(start, i);
        end = 0;
        decoded = false;
      }
      i = request.p;
      startSlash = path.startsWith("/");
      if (!hash && url_l.startsWith("file:")) {
        if (path.length <= 1 || url.length === 11 && url.endsWith(":/")) {
          Utils.resetRe_();
          return { u: "This has been the root path", p: null };
        }
        endSlash = true;
        i === 1 && (i = -1);
      } else if (!hash && url_l.startsWith("ftp:")) {
        endSlash = true;
      } else {
        endSlash = request.t != null ? !!request.t
          : path.length > 1 && path.endsWith("/")
            || (<RegExpI> /\.([a-z]{2,3}|jpeg|tiff)$/i).test(path); // just a try: not include .html
      }
      if (!i || i === 1) {
        path = "/";
      } else {
        const arr3 = path.substring(+startSlash, (path.length - +path.endsWith("/")) || +startSlash).split("/");
        i < 0 && (i += arr3.length);
        if (i <= 0) {
          path = "/";
        } else if (i > 0 && i < arr3.length) {
          arr3.length = i;
          path = arr3.join("/");
          path = (startSlash ? "/" : "") + path + (endSlash ? "/" : "");
        }
      }
      if (!end && url.substring(0, start).indexOf("git") > 0) {
        path = upperGitUrls(url, path) || path;
      }
      str = decoded ? enc(path) : path;
      url = url.substring(0, start) + (end ? str + url.substring(end) : str);
      Utils.resetRe_();
      return { u: url, p: path };
    } as SpecialHandlers[kFgReq.parseUpperUrl],
    /** searchAs: */ function (this: void, request: FgReq[kFgReq.searchAs], port: Port): void {
      let search = Backend.parse_(request), query: string | null | Promise<string | null>;
      if (!search || !search.k) {
        cPort = port;
        return Backend.showHUD_("No search engine found!");
      }
      query = request.s.trim() || (request.c ? Clipboard_.paste_() : "");
      if (query instanceof Promise) {
        query.then(doSearch, () => doSearch(null));
        return;
      }
      return doSearch(query);
      function doSearch(this: void, query2: string | null): void {
        let err = query2 === null ? "It's not allowed to read clipboard"
          : (query2 = (query2 as string).trim()) ? "" : "No selected or copied text found";
        if (err) {
          cPort = port;
          return Backend.showHUD_(err);
        }
        query2 = Utils.createSearchUrl_((query2 as string).split(Utils.spacesRe_), (search as ParsedSearch).k);
        return safeUpdate(query2);
      }
    },
    /** gotoSession: */ function (this: void, request: FgReq[kFgReq.gotoSession], port?: Port): void {
      const id = request.s, active = request.a !== false;
      cPort = findCPort(port) as Port;
      if (typeof id === "number") {
        chrome.tabs.update(id, {active: true}, function (tab): void {
          const err = onRuntimeError();
          err ? Backend.showHUD_("The target tab has gone!") : selectWnd(tab);
          return err;
        });
        return;
      }
      if (!chrome.sessions) {
        return complainNoSession();
      }
      chrome.sessions.restore(id, function (): void {
        const err = onRuntimeError();
        err && Backend.showHUD_("The closed session may be too old.");
        return err;
      });
      if (active) { return; }
      let tabId = (port as Port).s.t;
      tabId >= 0 || (tabId = TabRecency_.last_);
      if (tabId >= 0) { return selectTab(tabId); }
    },
    /** openUrl: */ function (this: void, request: FgReq[kFgReq.openUrl] & { url_f?: Urls.Url, opener?: boolean }
        , port?: Port): void {
      Object.setPrototypeOf(request, null);
      let unsafe = port != null && isNotVomnibarPage(port, true);
      cPort = unsafe ? port as Port : findCPort(port) || cPort;
      let url: Urls.Url | undefined = request.u;
      // { url_f: string, ... } | { copied: true, ... }
      const opts: OpenUrlOptions & {
        url_f?: Urls.Url;
        reuse?: ReuseType;
        copied?: boolean;
        keyword?: string | null;
      } & SafeObject = Object.create(null);
      opts.reuse = request.r;
      opts.incognito = request.i;
      opts.opener = false;
      if (url) {
        if (url[0] === ":" && request.o && (<RegExpOne> /^:[bdhostw]\s/).test(url)) {
          url = url.substring(2).trim();
          url || (unsafe = false);
        }
        url = Utils.fixCharsInUrl_(url);
        url = Utils.convertToUrl_(url, request.k || null
            , unsafe ? Urls.WorkType.ConvertKnown : Urls.WorkType.ActAnyway);
        const type = Utils.lastUrlType_;
        if (request.h != null && (type === Urls.Type.NoSchema || type === Urls.Type.NoProtocolName)) {
          url = (request.h ? "https" : "http") + (url as string).substring((url as string)[4] === "s" ? 5 : 4);
        } else if (unsafe && type === Urls.Type.PlainVimium && (url as string).startsWith("vimium:")) {
          url = Utils.convertToUrl_(url as string);
        }
        request.u = "";
        request.k = "";
        opts.url_f = url;
        opts.opener = unsafe && !request.n;
      } else {
        opts.copied = request.c;
        opts.keyword = request.k;
      }
      cRepeat = 1;
      cOptions = opts;
      return BackgroundCommands[kBgCmd.openUrl]();
    },
    /** focus: */ function (this: void, _0: FgReq[kFgReq.focus], port: Port): void {
      if (!(Build.BTypes & ~BrowserType.Firefox)
          || Build.BTypes & BrowserType.Firefox && OnOther === BrowserType.Firefox) {
        if (port.s.f & Frames.Flags.OtherExtension) {
          port.postMessage({ N: kBgReq.injectorRun, t: InjectorTask.reportLiving });
        }
      }
      let tabId = port.s.t, ref = framesForTab[tabId] as Frames.WritableFrames | undefined, status: Frames.ValidStatus;
      if (!ref) {
        return needIcon ? Backend.setIcon_(tabId, port.s.s) : undefined;
      }
      if (port === ref[0]) { return; }
      if (needIcon && (status = port.s.s) !== ref[0].s.s) {
        ref[0] = port;
        return Backend.setIcon_(tabId, status);
      }
      ref[0] = port;
    },
    /** checkIfEnabled: */ function (this: void, request: ExclusionsNS.Details | FgReq[kFgReq.checkIfEnabled]
        , port?: Frames.Port | null): void {
      if (!port) {
        port = indexFrame((request as ExclusionsNS.Details).tabId, (request as ExclusionsNS.Details).frameId);
        if (!port) { return; }
      }
      const { s: sender } = port, { u: oldUrl } = sender,
      pattern = Backend.getExcluded_(sender.u = (request as ExclusionsNS.Details).url
          || (request as FgReq[kFgReq.checkIfEnabled]).u
        , sender),
      status = pattern === null ? Frames.Status.enabled : pattern ? Frames.Status.partial : Frames.Status.disabled;
      if (sender.s !== status) {
        if (sender.f & Frames.Flags.locked) { return; }
        sender.s = status;
        if (needIcon && (framesForTab[sender.t] as Frames.Frames)[0] === port) {
          Backend.setIcon_(sender.t, status);
        }
      } else if (!pattern || pattern === Backend.getExcluded_(oldUrl, sender)) {
        return;
      }
      port.postMessage({ N: kBgReq.reset, p: pattern });
    },
    /** nextFrame: */ function (this: void, request: FgReq[kFgReq.nextFrame], port: Port): void {
      cPort = port;
      cRepeat = 1;
      cKey = request.k;
      const type = request.t || Frames.NextType.Default;
      if (type !== Frames.NextType.current) {
        return BackgroundCommands[type === Frames.NextType.parent ? kBgCmd.parentFrame : kBgCmd.nextFrame]();
      }
      const ports = framesForTab[port.s.t];
      if (ports) {
        ports[0].postMessage({
          N: kBgReq.focusFrame,
          k: cKey,
          m: FrameMaskType.NoMask
        });
        return;
      }
      safePost(port, { N: kBgReq.omni_returnFocus, l: cKey });
    },
    /** exitGrab: */ function (this: void, _0: FgReq[kFgReq.exitGrab], port: Port): void {
      const ports = framesForTab[port.s.t];
      if (!ports) { return; }
      ports[0].s.f |= Frames.Flags.userActed;
      if (ports.length < 3) { return; }
      for (let msg: Req.bg<kBgReq.exitGrab> = { N: kBgReq.exitGrab }, i = ports.length; 0 < --i; ) {
        const p = ports[i];
        if (p !== port) {
          p.postMessage(msg);
          p.s.f |= Frames.Flags.userActed;
        }
      }
    },
    /** execInChild: */ function (this: void, request: FgReqWithRes[kFgReq.execInChild]
        , port: Port): FgRes[kFgReq.execInChild] {
      const ports = framesForTab[port.s.t], url = request.u;
      if (!ports || ports.length < 3) { return false; }
      let iport: Port | null = null, i = ports.length;
      while (1 <= --i) {
        if (ports[i].s.u === url) {
          if (iport) { return false; }
          iport = ports[i];
        }
      }
      if (iport) {
        iport.postMessage({
          N: kBgReq.execute,
          S: ensureInnerCSS(iport),
          c: request.c, n: request.n || 1, a: request.a
        });
        return true;
      }
      return false;
    },
    /** initHelp: */ function (this: void, request: FgReq[kFgReq.initHelp], port: Port): void {
      if (port.s.u.startsWith(Settings.CONST_.OptionsPage_)) {
        request.t = true;
        request.b = true;
        request.n = true;
      }
      Promise.all([
        Utils.require_("HelpDialog"),
        request, port,
        new Promise<void>(function (resolve, reject) {
          const xhr = Settings.fetchFile_("helpDialog", resolve);
          xhr && (xhr.onerror = reject);
        })
      ]).then(function (args): void {
        const port2 = args[1].w && indexFrame(args[2].s.t, 0) || args[2];
        (port2.s as Frames.Sender).f |= Frames.Flags.hadHelpDialog;
        port2.postMessage({
          N: kBgReq.showHelpDialog,
          S: ensureInnerCSS(port2),
          h: args[0].render_(args[1]),
          o: Settings.CONST_.OptionsPage_,
          a: Settings.get_("showAdvancedCommands", true)
        });
      }, function (args): void {
        console.error("Promises for initHelp failed:", args[0], ";", args[3]);
      });
    },
    /** kFgReq.css: */ function (this: void, _0: {}, port: Port): void {
      (port.s as Frames.Sender).f |= Frames.Flags.hasCSSAndActed;
      port.postMessage({ N: kBgReq.showHUD, S: Settings.cache_.innerCSS });
    },
    /** vomnibar: */ function (this: void, request: FgReq[kFgReq.vomnibar] & Req.baseFg<kFgReq.vomnibar>
        , port: Port): void {
      const { c: count, i: inner } = request;
      if (count != null) {
        delete request.c, delete request.H, delete request.i;
        cRepeat = +count || 1;
        cOptions = Object.setPrototypeOf(request, null);
      } else if (request.r !== true) {
        return;
      } else if (cOptions == null || cOptions.secret !== -1) {
        if (inner) { return; }
        cOptions = Object.create(null);
        cRepeat = 1;
      } else if (inner && (cOptions as any as CmdOptions[kFgCmd.vomnibar]).v === Settings.CONST_.VomnibarPageInner_) {
        return;
      }
      cPort = port;
      return (BackgroundCommands[kBgCmd.showVomnibar] as (this: void, forceInner?: boolean) => void)(inner);
    },
    /** omni: */ function (this: void, request: FgReq[kFgReq.omni], port: Port): void {
      if (isNotVomnibarPage(port)) { return; }
      return Completion_.filter_(request.q, request,
      PostCompletions.bind<Port, 0 | 1 | 2
          , [Array<Readonly<CompletersNS.Suggestion>>, boolean, CompletersNS.MatchType, number], void>(port
        , (<number> request.i | 0) as number as 0 | 1 | 2));
    },
    /** copy: */ function (this: void, request: FgReq[kFgReq.copy]): void {
      Utils.copy_(request.d);
    },
    /** key: */ function (this: void, request: FgReq[kFgReq.key], port: Port): void {
      (port.s as Frames.Sender).f |= Frames.Flags.userActed;
      let key: string = request.k, count = 1
        , arr: null | string[] = numHeadRe.exec(key);
      if (arr != null) {
        let prefix = arr[0];
        key = key.substring(prefix.length);
        count = prefix !== "-" ? parseInt(prefix, 10) || 1 : -1;
      }
      const ref = CommandsData_.keyToCommandRegistry_;
      if (!(key in ref)) {
        arr = key.match(Utils.keyRe_) as string[];
        key = arr[arr.length - 1];
        count = 1;
      }
      const registryEntry = ref[key] as CommandsNS.Item;
      Utils.resetRe_();
      return executeCommand(registryEntry, count, request.l, port);
    },
    /** marks: */ function (this: void, request: FgReq[kFgReq.marks], port: Port): void {
      cPort = port;
      switch (request.a) {
      case kMarkAction.create: return Marks_.createMark_(request, port);
      case kMarkAction.goto: return Marks_.gotoMark_(request, port);
      case kMarkAction.clear: return Marks_.clear_(request.u);
      default: return;
      }
    },
    /** safe when cPort is null */
    /** focusOrLaunch: */ function (this: void, request: MarksNS.FocusOrLaunch
        , _port?: Port | null, notFolder?: true): void {
      // * do not limit windowId or windowType
      let url = Utils.reformatURL_(request.u.split("#", 1)[0]), callback = focusOrLaunch[0];
      let cb2: (result: Tab[], exArg: FakeArg) => void;
      if (url.startsWith("file:") && !notFolder && url.substring(url.lastIndexOf("/") + 1).indexOf(".") < 0) {
        url += "/";
        cb2 = function (tabs): void {
          return tabs && tabs.length > 0 ? callback.call(request, tabs)
            : requestHandlers[kFgReq.focusOrLaunch](request, null, true);
        };
      } else {
        request.p && (url += "*");
        cb2 = callback.bind(request);
      }
      chrome.tabs.query({ url, windowType: "normal" }, cb2);
    },
    /** cmd: */ function (this: void, request: FgReq[kFgReq.cmd], port: Port): void {
      const cmd = request.c, id = request.i;
      if (id >= -1 && gCmdTimer !== id) { return; } // an old / aborted / test message
      if (gCmdTimer) {
        clearTimeout(gCmdTimer);
        gCmdTimer = 0;
      }
      return executeCommand(CommandsData_.shortcutMap_[cmd as Exclude<typeof cmd, "">]
          , request.n, VKeyCodes.None, port);
    },
    /** removeSug: */ function (this: void, req: FgReq[kFgReq.removeSug], port?: Port): void {
      return Backend.removeSug_(req, port);
    },
    /** openImage: */ function (this: void, req: FgReq[kFgReq.openImage], port: Port) {
      let url = req.u, parsed = Utils.safeParseURL_(url);
      if (!parsed) {
        cPort = port;
        Backend.showHUD_("The selected image URL is invalid");
        return;
      }
      let prefix = Settings.CONST_.ShowPage_ + "#!image ";
      if (req.f) {
        prefix += "download=" + encodeURIComponent(req.f) + "&";
      }
      if (req.a !== false) {
        prefix += "auto=once&";
      }
      openShowPage[0](prefix + url, req.r, { opener: true });
    },
    /** gotoMainFrame: */ function (this: void, req: FgReq[kFgReq.gotoMainFrame], port: Port): void {
      const tabId = port.s.t, mainPort = indexFrame(tabId, 0);
      if (mainPort || Build.MinCVer < BrowserVer.MinWithFrameId && Build.BTypes & BrowserType.Chrome && NoFrameId
          || !chrome.webNavigation) {
        return gotoMainFrame(req, port, mainPort);
      }
      chrome.webNavigation.getAllFrames({ tabId },
      function (frames: chrome.webNavigation.GetAllFrameResultDetails[]): void {
        let frameId = port.s.i, port2: Port | null | false | void;
        for (const i of frames) {
          if (i.frameId === frameId) {
            frameId = i.parentFrameId;
            port2 = frameId > 0 && indexFrame(tabId, frameId);
            if (port2) {
              break;
            }
          }
        }
        gotoMainFrame(req, port, port2 || null);
      });
    },
    /** setOmniStyle: */ function (this: void, req: FgReq[kFgReq.setOmniStyle]): void {
      let styles = req.s.trim(), vomnibarOptions = Settings.cache_.vomnibarOptions;
      if (styles === vomnibarOptions.styles) { return; }
      const newOptions: SettingsNS.BackendSettings["vomnibarOptions"] = Utils.extendIf_({}, vomnibarOptions);
      newOptions.styles = styles;
      Settings.set_("vomnibarOptions", newOptions);
    },
    /** findFromVisual */ function (this: void, _: {}, port: Port): void {
      cOptions = Object.setPrototypeOf({ active: true, returnToViewport: true }, null);
      cPort = port;
      cRepeat = 1;
      BackgroundCommands[kBgCmd.performFind]();
    }
  ],
  framesForOmni: Frames.WritableFrames = [];
  function OnMessage <K extends keyof FgReq, T extends keyof FgRes>(this: void, request: Req.fg<K> | Req.fgWithRes<T>
      , port: Frames.Port): void {
    type ReqK = keyof FgReq;
    type ResK = keyof FgRes;
    if (request.H !== kFgReq.msg) {
      return (requestHandlers as {
        [T2 in ReqK]: (req: Req.fg<T2>, port: Frames.Port) => void;
      } as {
        [T2 in ReqK]: <T3 extends ReqK>(req: Req.fg<T3>, port: Frames.Port) => void;
      })[request.H](request as Req.fg<K>, port);
    }
    port.postMessage<T>({
      N: kBgReq.msg,
      m: (request as Req.fgWithRes<T>).i,
      r: (requestHandlers as {
        [T2 in ResK]: (req: Req.fgWithRes<T2>["a"], port: Frames.Port) => FgRes[T2];
      } as {
        [T2 in ResK]: <T3 extends ResK>(req: Req.fgWithRes<T3>["a"], port: Frames.Port) => FgRes[T3];
      })[(request as Req.fgWithRes<T>).c]((request as Req.fgWithRes<T>).a, port)
    });
  }
  function OnConnect(this: void, port: Frames.Port, type: number): void {
    const sender = formatPortSender(port), { t: tabId, u: url } = sender;
    let status: Frames.ValidStatus, ref = framesForTab[tabId] as Frames.WritableFrames | undefined;
    if (type >= PortType.omnibar || (url === Settings.cache_.vomnibarPage_f)) {
      if (type < PortType.knownStatusBase) {
        if (onOmniConnect(port, tabId, type)) {
          return;
        }
        status = Frames.Status.enabled;
        sender.f = Frames.Flags.userActed;
      } else if (Build.BTypes & BrowserType.Firefox && Build.OverrideNewTab && type === PortType.CloseSelf) {
        if (tabId >= 0 && !sender.i) {
          removeTempNewTab(tabId, port);
        }
        return;
      } else {
        status = ((type >>> PortType.BitOffsetOfKnownStatus) & PortType.MaskOfKnownStatus) - 1;
        sender.f = ((type & PortType.isLocked) ? Frames.Flags.lockedAndUserActed : Frames.Flags.userActed
          ) + ((type & PortType.hasCSS) && Frames.Flags.hasCSS);
      }
      port.postMessage({
        N: kBgReq.settingsUpdate,
        d: Settings.payload_
      });
    } else {
      let pass: null | string, flags: Frames.Flags = Frames.Flags.blank;
      if (ref && ((flags = sender.f = ref[0].s.f & Frames.Flags.InheritedFlags) & Frames.Flags.locked)) {
        status = ref[0].s.s;
        pass = status !== Frames.Status.disabled ? null : "";
      } else {
        pass = Backend.getExcluded_(url, sender);
        status = pass === null ? Frames.Status.enabled : pass ? Frames.Status.partial : Frames.Status.disabled;
      }
      port.postMessage({
        N: kBgReq.init,
        s: flags,
        c: Settings.payload_,
        p: pass,
        m: CommandsData_.mapKeyRegistry_,
        k: CommandsData_.keyMap_
      });
    }
    sender.s = status;
    (port as chrome.runtime.Port).sender.tab = null as never;
    port.onDisconnect.addListener(OnDisconnect);
    port.onMessage.addListener(OnMessage);
    if (ref) {
      ref.push(port);
      if (type & PortType.hasFocus) {
        if (needIcon && ref[0].s.s !== status) {
          Backend.setIcon_(tabId, status);
        }
        ref[0] = port;
      }
    } else {
      framesForTab[tabId] = [port, port];
      status !== Frames.Status.enabled && needIcon && Backend.setIcon_(tabId, status);
    }
    if (Build.MinCVer < BrowserVer.MinWithFrameId && Build.BTypes & BrowserType.Chrome && NoFrameId) {
      (sender as Writeable<Frames.Sender>).i = (type & PortType.isTop) ? 0 : ((Math.random() * 9999997) | 0) + 2;
    }
  }
  function OnDisconnect(this: void, port: Port): void {
    let { t: tabId } = port.s, i: number, ref = framesForTab[tabId] as Frames.WritableFrames | undefined;
    if (!ref) { return; }
    i = ref.lastIndexOf(port);
    if (!port.s.i) {
      if (i >= 0) {
        delete framesForTab[tabId];
      }
      return;
    }
    if (i === ref.length - 1) {
      --ref.length;
    } else if (i >= 1) {
      ref.splice(i, 1);
    }
    if (ref.length <= 1) {
      delete framesForTab[tabId];
      return;
    }
    if (port === ref[0]) {
      ref[0] = ref[1];
    }
  }
  function onOmniConnect(port: Frames.Port, tabId: number, type: PortType): boolean {
    if (type >= PortType.omnibar) {
      if (!isNotVomnibarPage(port)) {
        if (tabId < 0) {
          (port.s as Writeable<Frames.Sender>).t = type !== PortType.omnibar ? _fakeTabId--
              : cPort ? cPort.s.t : TabRecency_.last_;
        }
        framesForOmni.push(port);
        (port as chrome.runtime.Port).sender.tab = null as never;
        port.onDisconnect.addListener(OnOmniDisconnect);
        port.onMessage.addListener(OnMessage);
        type === PortType.omnibar &&
        port.postMessage({
          N: kBgReq.omni_secret,
          b: !(Build.BTypes & ~BrowserType.Chrome) || !(Build.BTypes & ~BrowserType.Firefox)
              || !(Build.BTypes & ~BrowserType.Edge) ? Build.BTypes as number as BrowserType : OnOther,
          v: ChromeVer,
          o: Settings.cache_.vomnibarOptions,
          S: Settings.cache_.omniCSS_,
          s: getSecret()
        });
        return true;
      }
    } else if (tabId < 0 // should not be true; just in case of misusing
      || (Build.MinCVer < BrowserVer.Min$tabs$$executeScript$hasFrameIdArg
          && Build.BTypes & BrowserType.Chrome
          && ChromeVer < BrowserVer.Min$tabs$$executeScript$hasFrameIdArg)
      || port.s.i === 0
      ) { /* empty */ }
    else {
      chrome.tabs.executeScript(tabId, {
        file: Settings.CONST_.VomnibarScript_,
        frameId: port.s.i,
        runAt: "document_start"
      }, onRuntimeError);
      port.disconnect();
      return true;
    }
    return false;
  }
  function OnOmniDisconnect(this: void, port: Port): void {
    const ref = framesForOmni, i = ref.lastIndexOf(port);
    if (i === ref.length - 1) {
      --ref.length;
    } else if (i >= 0) {
      ref.splice(i, 1);
    }
  }
  function formatPortSender(port: Port): Frames.Sender {
    const sender = (port as chrome.runtime.Port).sender, tab = sender.tab || {
      id: _fakeTabId--,
      url: "",
      incognito: false
    };
    return (port as Writeable<Port>).s = {
      i: Build.MinCVer >= BrowserVer.MinWithFrameId || !(Build.BTypes & BrowserType.Chrome)
          ? sender.frameId as number : sender.frameId || 0,
      a: tab.incognito,
      s: Frames.Status.enabled,
      f: Frames.Flags.blank,
      t: tab.id,
      u: Build.BTypes & BrowserType.Edge ? sender.url || tab.url || "" : sender.url as string
    };
  }

  function removeTempNewTab(tabId: number, port: chrome.runtime.Port): void {
    let wndId = (port.sender.tab as chrome.tabs.Tab).windowId;
    if (_removeTempTabLock) {
      _removeTempTabLock.then(_removeTempNewTab.bind(null, tabId, wndId));
    } else {
      interface LatestPromise extends Promise<void> {
        finally (onFinally: () => void): LatestPromise;
      }
      _removeTempTabLock = (_removeTempNewTab(tabId, wndId) as LatestPromise).finally(function (): void {
        _removeTempTabLock = null;
      });
    }
  }

  function _removeTempNewTab(tabId: number, windowId: number): Promise<void> {
    let promise = chrome.tabs.remove(tabId) as never as Promise<void>;
    promise = promise.then(function () {
      return chrome.sessions.getRecentlyClosed({ maxResults: 1 });
    }).then(function (sessions: chrome.sessions.Session[]): void {
      const tab = sessions && sessions[0] && sessions[0].tab;
      tab && chrome.sessions.forgetClosedTab(windowId, tab.sessionId as string);
    });
    return promise;
  }

  Backend = {
    gotoSession_: requestHandlers[kFgReq.gotoSession],
    openUrl_: requestHandlers[kFgReq.openUrl],
    checkIfEnabled_: requestHandlers[kFgReq.checkIfEnabled],
    focus_: requestHandlers[kFgReq.focusOrLaunch],
    getExcluded_: Utils.getNull_,
    IconBuffer_: null,
    removeSug_ (this: void, { t: type, u: url }: FgReq[kFgReq.removeSug], port?: Port | null): void {
      const name = type === "tab" ? type : type + " item";
      cPort = findCPort(port) as Port;
      if (type === "tab" && TabRecency_.last_ === +url) {
        return Backend.showHUD_("The current tab should be kept.");
      }
      return Completion_.removeSug_(url, type, function (succeed): void {
        return Backend.showHUD_(succeed ? `Succeed to delete a ${name}` : `The ${name} is not found!`);
      });
    },
    setIcon_ (): void { /* empty */ },
    complain_ (action: string): void {
      return this.showHUD_("It's not allowed to " + action);
    },
    parse_ (this: void, request: FgReqWithRes[kFgReq.parseSearchUrl]): FgRes[kFgReq.parseSearchUrl] {
      let s0 = request.u, url = s0.toLowerCase(), pattern: Search.Rule | undefined
        , arr: string[] | null = null, _i: number, selectLast = false;
      if (!Utils.protocolRe_.test(Utils.removeComposedScheme_(url))) {
        Utils.resetRe_();
        return null;
      }
      if (request.p) {
        const obj = requestHandlers[kFgReq.parseUpperUrl](request as FgReqWithRes[kFgReq.parseUpperUrl]);
        obj.p != null && (s0 = obj.u);
        return { k: "", s: 0, u: s0 };
      }
      const decoders = Settings.cache_.searchEngineRules;
      if (_i = Utils.IsURLHttp_(url)) {
        url = url.substring(_i);
        s0 = s0.substring(_i);
      }
      for (_i = decoders.length; 0 <= --_i; ) {
        pattern = decoders[_i];
        if (!url.startsWith(pattern.prefix)) { continue; }
        arr = s0.substring(pattern.prefix.length).match(pattern.matcher);
        if (arr) { break; }
      }
      if (!arr || !pattern) { Utils.resetRe_(); return null; }
      if (arr.length > 1 && !pattern.matcher.global) { arr.shift(); }
      const re = pattern.delimiter;
      if (arr.length > 1) {
        selectLast = true;
      } else if (re instanceof RegExp) {
        url = arr[0];
        if (arr = url.match(re)) {
          arr.shift();
          selectLast = true;
        } else {
          arr = [url];
        }
      } else {
        arr = arr[0].split(re);
      }
      url = "";
      for (_i = 0; _i < arr.length; _i++) { url += " " + Utils.DecodeURLPart_(arr[_i]); }
      url = url.trim().replace(Utils.spacesRe_, " ");
      Utils.resetRe_();
      return {
        k: pattern.name,
        u: url,
        s: selectLast ? url.lastIndexOf(" ") + 1 : 0
      };
    },
    reopenTab_ (this: void, tab: Tab, refresh?: boolean): void {
      const tabId = tab.id;
      if (refresh) {
        chrome.tabs.remove(tabId, onRuntimeError);
        let step = RefreshTabStep.start,
        onRefresh = function (this: void): void {
          const err = onRuntimeError();
          if (err) {
            chrome.sessions.restore();
            return err;
          }
          step = step + 1;
          if (step >= RefreshTabStep.end) { return; }
          setTimeout(function (): void {
            chrome.tabs.get(tabId, onRefresh);
          }, 50 * step * step);
        };
        chrome.tabs.get(tabId, onRefresh);
        return;
      }
      tabsCreate({
        windowId: tab.windowId,
        index: tab.index,
        url: tab.url,
        active: tab.active,
        pinned: tab.pinned,
        openerTabId: tab.openerTabId,
      });
      chrome.tabs.remove(tabId);
      // not seems to need to restore muted status
    },
    showHUD_ (message: string, isCopy?: boolean): void {
      if (cPort && !safePost(cPort, {
          N: kBgReq.showHUD,
          S: ensureInnerCSS(cPort),
          t: message,
          c: isCopy === true
        })) {
        cPort = null as never;
      }
    },
    forceStatus_ (act: Frames.ForcedStatusText, tabId?: number): void {
      const ref = framesForTab[tabId || (tabId = TabRecency_.last_)];
      if (!ref) { return; }
      act = act.toLowerCase() as Frames.ForcedStatusText;
      const always_enabled = Exclusions == null || Exclusions.rules_.length <= 0, oldStatus = ref[0].s.s,
      stat = act === "enable" ? Frames.Status.enabled : act === "disable" ? Frames.Status.disabled
        : act === "toggle" ? oldStatus !== Frames.Status.enabled ? Frames.Status.enabled : Frames.Status.disabled
        : null,
      locked = stat !== null, unknown = !(locked || always_enabled),
      msg: Req.bg<kBgReq.reset> = { N: kBgReq.reset, p: stat !== Frames.Status.disabled ? null : "", f: locked };
      cPort = indexFrame(tabId, 0) || ref[0];
      if (stat === null && tabId < 0) {
        oldStatus !== Frames.Status.disabled && this.showHUD_("Got an unknown action on status: " + act);
        return;
      }
      let pattern: string | null, newStatus = locked ? stat as Frames.ValidStatus : Frames.Status.enabled;
      for (let i = ref.length; 1 <= --i; ) {
        const port = ref[i], sender = port.s;
        sender.f = locked ? sender.f | Frames.Flags.locked : sender.f & ~Frames.Flags.locked;
        if (unknown) {
          pattern = msg.p = this.getExcluded_(sender.u, sender);
          newStatus = pattern === null ? Frames.Status.enabled : pattern
            ? Frames.Status.partial : Frames.Status.disabled;
          if (newStatus !== Frames.Status.partial && sender.s === newStatus) { continue; }
        }
        // must send "reset" messages even if port keeps enabled by 'v.st enable'
        // - frontend may need to reinstall listeners
        sender.s = newStatus;
        port.postMessage(msg);
      }
      newStatus !== Frames.Status.disabled && this.showHUD_("Now the page status is " + (
        newStatus === Frames.Status.enabled ? "enabled" : "partially disabled" ));
      if (needIcon && (newStatus = ref[0].s.s) !== oldStatus) {
        return this.setIcon_(tabId, newStatus);
      }
    },
    ExecuteShortcut_ (this: void, cmd: kShortcutNames | kShortcutAliases & string): void {
      const tabId = TabRecency_.last_, ports = framesForTab[tabId];
      if (cmd === kShortcutAliases.nextTab1) { cmd = kShortcutNames.nextTab; }
      if (ports == null || (ports[0].s.f & Frames.Flags.userActed) || tabId < 0) {
        return executeShortcut(cmd, ports);
      }
      ports && (ports[0].s.f |= Frames.Flags.userActed);
      chrome.tabs.get(tabId, function (tab): void {
        executeShortcut(cmd as kShortcutNames, tab && tab.status === "complete" ? framesForTab[tab.id] : null);
        return onRuntimeError();
      });
    },
    indexPorts_: function (tabId?: number, frameId?: number): Frames.FramesMap | Frames.Frames | Port | null {
      return tabId == null ? framesForTab
        : frameId == null ? (tabId === GlobalConsts.VomnibarFakeTabId ? framesForOmni : framesForTab[tabId] || null)
        : indexFrame(tabId, frameId);
    } as BackendHandlersNS.BackendHandlers["indexPorts_"],
    onInit_(): void {
      // the line below requires all necessary have inited when calling this
      Backend.onInit_ = null;
      Settings.postUpdate_("vomnibarOptions");
      // note: remove the block below on v1.75
      const storage = localStorage, oldStyles = storage.getItem("styles");
      if (oldStyles) {
        storage.removeItem("styles");
        requestHandlers[kFgReq.setOmniStyle]({ s: oldStyles });
      }
      chrome.runtime.onConnect.addListener(function (port): void {
        return OnConnect(port as Frames.Port,
            (port.name.substring(PortNameEnum.PrefixLen) as string | number as number) | 0);
      });
      if (Build.BTypes & ~BrowserType.Chrome && !chrome.runtime.onConnectExternal) { return; }
      Settings.postUpdate_("extWhiteList");
      (chrome.runtime.onConnectExternal as chrome.runtime.ExtensionConnectEvent).addListener(function (port): void {
        let { sender, name } = port, arr: string[];
        if (sender
            && (Build.BTypes & ~BrowserType.Chrome ? isExtIdAllowed(sender.id, sender.url) : isExtIdAllowed(sender.id))
            && name.startsWith(PortNameEnum.Prefix) && (arr = name.split(PortNameEnum.Delimiter)).length > 1) {
          if (arr[1] !== Settings.CONST_.GitVer) {
            (port as Port).postMessage({ N: kBgReq.injectorRun, t: InjectorTask.reload });
            port.disconnect();
            return;
          }
          OnConnect(port as Frames.Port, (arr[0].substring(PortNameEnum.PrefixLen) as string | number as number) | 0);
          if (Build.BTypes & BrowserType.Firefox) {
            (port as Frames.Port).s.f |= Frames.Flags.OtherExtension;
          }
        } else {
          port.disconnect();
        }
      });
    }
  };

  Settings.updateHooks_.newTabUrl_f = function (url) {
    const onlyNormal = Utils.isRefusingIncognito_(url),
    mayForceIncognito = Build.MinCVer < BrowserVer.MinNoUnmatchedIncognito && Build.BTypes & BrowserType.Chrome
      && onlyNormal && ChromeVer < BrowserVer.MinNoUnmatchedIncognito;
    BackgroundCommands[kBgCmd.createTab] = Build.MinCVer < BrowserVer.MinNoUnmatchedIncognito
        && Build.BTypes & BrowserType.Chrome && mayForceIncognito ? function (): void {
      getCurWnd(true, hackedCreateTab[0].bind(url));
    } : standardCreateTab.bind(null, url, onlyNormal);
    if (Build.MinCVer < BrowserVer.MinNoUnmatchedIncognito && Build.BTypes & BrowserType.Chrome) {
      BgCmdInfo[kBgCmd.createTab] = mayForceIncognito ? UseTab.NoTab : UseTab.ActiveTab;
    }
  };

  Settings.updateHooks_.showActionIcon = function (value) {
    needIcon = value && !!chrome.browserAction;
  };

  (!(Build.BTypes & ~BrowserType.Chrome) || chrome.runtime.onMessageExternal) &&
  ((chrome.runtime.onMessageExternal as chrome.runtime.ExtensionMessageEvent).addListener(function (this: void
      , message: boolean | number | string | null | undefined | ExternalMsgs[keyof ExternalMsgs]["req"]
      , sender, sendResponse): void {
    let command: string | undefined;
    if (Build.BTypes & ~BrowserType.Chrome ? !isExtIdAllowed(sender.id, sender.url) : !isExtIdAllowed(sender.id)) {
      sendResponse(false);
      return;
    }
    if (typeof message === "string") {
      command = message;
      if (command && CommandsData_.availableCommands_[command]) {
        const tab = sender.tab, frames = tab ? framesForTab[tab.id] : null,
        port = frames ? indexFrame((tab as Tab).id, sender.frameId || 0) || frames[0] : null;
        return executeAny(command, null, 1, port);
      }
      return;
    }
    if (typeof message !== "object" || !message) { return; }
    if (message.handler === kFgReq.inject || message.handler === kFgReq.injectDeprecated) {
      (sendResponse as (res: ExternalMsgs[kFgReq.inject]["res"]) => void | 1)({
        scripts: message.scripts ? Settings.CONST_.ContentScripts_ : null,
        version: Settings.CONST_.VerCode_,
        host: !(Build.BTypes & ~BrowserType.Chrome) ? "" : location.host,
        versionHash: Settings.CONST_.GitVer
      });
    } else if (message.handler === kFgReq.command) {
      command = message.command ? message.command + "" : "";
      if (command && CommandsData_.availableCommands_[command]) {
        const tab = sender.tab, frames = tab ? framesForTab[tab.id] : null,
        port = frames ? indexFrame((tab as Tab).id, sender.frameId || 0) || frames[0] : null;
        executeAny(command, message.options as CommandsNS.RawOptions | null, message.count as number | string
          , port, message.key);
      }
    }
  }), Settings.postUpdate_("extWhiteList"));

  chrome.tabs.onReplaced.addListener(function (addedTabId, removedTabId) {
    const ref = framesForTab, frames = ref[removedTabId];
    if (!frames) { return; }
    delete ref[removedTabId];
    ref[addedTabId] = frames;
    for (let i = frames.length; 0 < --i; ) {
      (frames[i].s as Writeable<Frames.Sender>).t = addedTabId;
    }
  });

  Settings.postUpdate_("vomnibarPage", null);
  Settings.postUpdate_("searchUrl", null); // will also update newTabUrl

  // will run only on <F5>, not on runtime.reload
  window.onunload = function (event): void {
    if (event
        && (Build.MinCVer >= BrowserVer.Min$Event$$IsTrusted || !(Build.BTypes & BrowserType.Chrome)
            ? !event.isTrusted : event.isTrusted === false)) { return; }
    let ref = framesForTab as Frames.FramesMapToDestroy;
    ref.omni = framesForOmni;
    for (const tabId in ref) {
      const arr = ref[tabId];
      for (let i = arr.length; 0 < --i; ) {
        arr[i].disconnect();
      }
    }
    if (framesForOmni.length > 0) {
      framesForOmni[0].disconnect();
    }
  };
})();
