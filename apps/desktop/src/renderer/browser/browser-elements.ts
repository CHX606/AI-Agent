export function browserElements(pane: HTMLElement) {
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => pane.querySelector<T>(selector)!;
  return {
    get,
    form: get<HTMLFormElement>(".browser-address"),
    address: get<HTMLInputElement>(".browser-address input"),
    zoom: get<HTMLButtonElement>(".browser-zoom"),
    tabs: get(".browser-tabs"),
    stage: get(".browser-stage"),
    snapshot: get<HTMLImageElement>(".browser-snapshot"),
    start: get(".browser-start"),
    failure: get(".browser-error"),
    progress: get(".browser-progress"),
    star: get<HTMLButtonElement>(".browser-bookmark"),
    button: (action: string) => get<HTMLButtonElement>(`.browser-toolbar [data-action="${action}"]`),
  };
}

export type BrowserElements = ReturnType<typeof browserElements>;
