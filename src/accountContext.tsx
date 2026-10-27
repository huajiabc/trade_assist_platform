import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { emptyAccountStatus, type AccountStatus } from '../shared/account';
import { accountRequest } from './services/account';
interface AccountContextValue {status:AccountStatus;busy:boolean;error:string;connect:()=>Promise<AccountStatus|undefined>;refresh:()=>Promise<AccountStatus|undefined>;disconnect:()=>Promise<AccountStatus|undefined>}
const AccountContext=createContext<AccountContextValue>({status:emptyAccountStatus(),busy:false,error:'',connect:async()=>undefined,refresh:async()=>undefined,disconnect:async()=>undefined});
/** Browser memory holds normalized account data only. Credentials are never requested or persisted. */
export function AccountProvider({children}:{children:ReactNode}){
 const [status,setStatus]=useState(emptyAccountStatus),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=useRef(true),pending=useRef<Promise<AccountStatus|undefined>|null>(null),controller=useRef<AbortController|null>(null);
 const call=useCallback((action:'status'|'connect'|'refresh'|'disconnect'):Promise<AccountStatus|undefined>=>{
  if(pending.current)return action==='status'?pending.current:pending.current.then(()=>call(action));
  const abort=new AbortController();controller.current=abort;const timer=window.setTimeout(()=>abort.abort(),20000);if(action!=='status')setBusy(true);
  const promise=(async()=>{try{const next=await accountRequest(action,abort.signal);if(active.current){setStatus(next);setError('');}return next;}
    catch(e){if(active.current){setError(e instanceof Error?e.message:'账户状态读取失败。');setStatus(previous=>({...previous,validity:previous.snapshot?'stale':'unavailable',error:{code:'ACCOUNT_CLIENT_ERROR',message:'账户服务连接异常，旧快照不能视为当前持仓。'}}));}return undefined;}
    finally{window.clearTimeout(timer);pending.current=null;controller.current=null;if(active.current)setBusy(false);}})();pending.current=promise;return promise;
 },[]);
 useEffect(()=>{active.current=true;queueMicrotask(()=>{if(active.current)void call('status');});const timer=window.setInterval(()=>void call('status'),10000);return()=>{active.current=false;window.clearInterval(timer);controller.current?.abort();};},[call]);
 return <AccountContext.Provider value={{status,busy,error,connect:()=>call('connect'),refresh:()=>call('refresh'),disconnect:()=>call('disconnect')}}>{children}</AccountContext.Provider>;
}
export const useAccount=()=>useContext(AccountContext);
