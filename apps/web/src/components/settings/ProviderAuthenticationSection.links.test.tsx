// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ auth: null as unknown, command: vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: state.auth, error: null }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("./settingsLayout", () => ({ SettingsRow: ({ control, children }: {control: React.ReactNode;children:React.ReactNode}) => <div>{control}{children}</div> }));
vi.mock("../../localApi", () => ({ ensureLocalApi: () => { throw new Error("No guest opener permitted"); } }));
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
let container: HTMLDivElement;let root:Root;
const url="https://provider.invalid/sign-in?exact=yes";
const auth = { phase:"waiting",flowId:"flow",interaction:{ type:"browser",id:"interaction",url,requiresConsent:true,acceptsCallback:false } };
const props={ environmentId:"env",environmentLabel:"Fixture",instanceId:"provider",provider:{driver:"acpRegistry",enabled:true,installed:true,displayName:"Fixture",auth:{status:"unknown"},setup:{canAuthenticate:true}},readOnly:false } as unknown as ComponentProps<typeof ProviderAuthenticationSection>;
async function render(){await act(async()=>root.render(<ProviderAuthenticationSection {...props}/>));}
function button(label:string){const b=[...container.querySelectorAll('button')].find(b=>b.textContent===label);if(!b)throw new Error('missing '+label);return b;}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});container=document.createElement('div');document.body.append(container);root=createRoot(container);state.auth=auth;state.command.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
test("consent failure keeps the URL inaccessible, retry exposes an ordinary anchor only after success",async()=>{
  state.command.mockResolvedValueOnce({_tag:"Failure",cause:{}});await render();
  expect(container.querySelector(`a[href="${url}"]`)).toBeNull();
  await act(async()=>button("Allow browser sign-in").click());expect(container.querySelector(`a[href="${url}"]`)).toBeNull();
  state.command.mockResolvedValueOnce({_tag:"Success",value:null});
  await act(async()=>button("Allow browser sign-in").click());
  const link=container.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)!;expect(link.textContent).toBe("Open browser");
  const event=new MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);
  expect(state.command.mock.calls.at(-1)?.[0].input.response).toEqual({type:"browser",action:"accept"});
});
test("pending consent and a declined/cancelled flow do not expose the browser URL",async()=>{
  let finish!:(value:unknown)=>void;state.command.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await render();
  await act(async()=>button("Allow browser sign-in").click());expect(container.querySelector(`a[href="${url}"]`)).toBeNull();
  await act(async()=>finish({_tag:"Failure",cause:{}}));
  state.auth={...auth,phase:"cancelled",interaction:null,authorizationUrl:null};await render();expect(container.querySelector(`a[href="${url}"]`)).toBeNull();
});
test("non-consent URLs are ordinary links immediately and a new flow needs its own consent",async()=>{
  state.auth={...auth,interaction:{...auth.interaction,requiresConsent:false}};await render();expect(container.querySelector(`a[href="${url}"]`)).not.toBeNull();
  state.auth={...auth,flowId:"second"};await render();expect(container.querySelector(`a[href="${url}"]`)).toBeNull();
});
