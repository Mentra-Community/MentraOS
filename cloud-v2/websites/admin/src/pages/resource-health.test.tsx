import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ResourceHealthSection} from './resource-health';
const at=new Date().toISOString();
function render(stale=false) {
 const query=new QueryClient({defaultOptions:{queries:{retry:false}}});
 query.setQueryData(['resource-lifecycle'],{subjects:[{subject:{id:'account-shared'},generation:4,status:'idle',current:true,observedAt:stale?'2020-01-01T00:00:00Z':at,receivedAt:at,owner:null,reason:null,
  resource:{kind:'google-account',placement:'fleet',memberships:[]},idle:{outcome:'passed',contractVersion:'account-v1',qualifiedScope:{kind:'fleet'}},repair:{configured:true,state:'none'}}],history:[{id:'journal-4',resourceId:'account-shared',subjectGeneration:4,at,event:'released',ownerId:'run-previous',ownerGeneration:3,hostId:'borrower-host',laneId:'android'}]});
 const html=renderToStaticMarkup(<QueryClientProvider client={query}><ResourceHealthSection/></QueryClientProvider>);query.clear();return html;
}
test('fleet card exposes shared identity and borrower lineage without membership',()=>{const html=render();expect(html).toContain('Fleet resource');expect(html).toContain('account-shared');expect(html).toContain('run-previous (owner generation 3)');expect(html).toContain('borrower-host/android');expect(html).not.toContain('Installed:');expect(html).toContain('Idle')});
test('clock expiry renders unknown while preserving accepted check and history',()=>{const html=render(true);expect(html).toContain('Unknown');expect(html).not.toContain('>Idle<');expect(html).toContain('Last reported owner');expect(html).toContain('account-v1');expect(html).toContain('run-previous')});
