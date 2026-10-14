"""Repeatable local user/vhost provisioning. Secrets stay out of arguments and logs."""
import base64,json,os,urllib.request,urllib.parse
from pathlib import Path
env={}
for line in Path('.env.messaging').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key,value=line.split('=',1);env[key]=value
user=env['RABBITMQ_ADMIN_USER'];password=env['RABBITMQ_ADMIN_PASSWORD']
origin='http://127.0.0.1:'+env.get('RABBITMQ_MANAGEMENT_PORT','15673')
auth=base64.b64encode((user+':'+password).encode()).decode()
def put(path,body):
    request=urllib.request.Request(origin+'/api/'+path,data=json.dumps(body).encode(),method='PUT',headers={'Authorization':'Basic '+auth,'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=10):pass
vhost=env.get('RABBITMQ_VHOST','commerce')
try:
    put('vhosts/'+urllib.parse.quote(vhost,safe=''),{})
    put('vhosts/commerce_test',{})
    for service in ['orders','inventory','payments']:
        name='commerce_'+service
        put('users/'+name,{'password':env['RABBITMQ_'+service.upper()+'_PASSWORD'],'tags':''})
        resources=r'^(commerce\.events|commerce\.'+service+r'\.handoff|'+service+r'\..*)$'
        put('permissions/'+vhost+'/'+name,{'configure':resources,'write':resources,'read':resources})
        publish={'orders':r'^(order\..*|inventory\.(reserve|confirm|release|compensate)\.requested|payment\.(process|refund)\.requested)\.v1$','inventory':r'^(inventory\.[^.]+|checkout\.inventory\.[^.]+)\.v1$','payments':r'^(payment\.[^.]+|checkout\.payment\.[^.]+)\.v1$'}[service]
        subscribe={'orders':r'^((inventory|payment)\.[^.]+|checkout\.(inventory|payment)\.[^.]+)\.v1$','inventory':r'^(order\.created|inventory\.(reserve|confirm|release|compensate)\.requested)\.v1$','payments':r'^(order\.created|payment\.(process|refund)\.requested)\.v1$'}[service]
        put('topic-permissions/'+vhost+'/'+name,{'exchange':'commerce.events','write':publish,'read':subscribe})
    if env.get('RABBITMQ_NOTIFICATIONS_PASSWORD'):
        name='commerce_notifications'
        put('users/'+name,{'password':env['RABBITMQ_NOTIFICATIONS_PASSWORD'],'tags':''})
        resources=r'^(commerce\.events|commerce\.notifications\.handoff|notifications\..*)$'
        write=r'^(commerce\.notifications\.handoff|notifications\..*)$'
        put('permissions/'+vhost+'/'+name,{'configure':write,'write':write,'read':resources})
        read=r'^(order\.(confirmed|cancelled)|checkout\.payment\.(succeeded|failed)|payment\.refund_(succeeded|failed|reconciliation_required))\.v1$'
        put('topic-permissions/'+vhost+'/'+name,{'exchange':'commerce.events','write':r'(?!)','read':read})
    if env.get('RABBITMQ_CATALOG_PASSWORD'):
        name='commerce_catalog'
        put('users/'+name,{'password':env['RABBITMQ_CATALOG_PASSWORD'],'tags':''})
        put('permissions/'+vhost+'/'+name,{'configure':r'(?!)','write':r'^commerce\.events$','read':r'^commerce\.events$'})
        put('topic-permissions/'+vhost+'/'+name,{'exchange':'commerce.events','write':r'^catalog\.product\.(created|updated|deleted)\.v1$','read':r'(?!)'})
    if env.get('RABBITMQ_SEARCH_PASSWORD'):
        name='commerce_search'
        put('users/'+name,{'password':env['RABBITMQ_SEARCH_PASSWORD'],'tags':''})
        owned=r'^(commerce\.search\.handoff|search\..*)$'
        put('permissions/'+vhost+'/'+name,{'configure':owned,'write':owned,'read':r'^(commerce\.events|commerce\.search\.handoff|search\..*)$'})
        put('topic-permissions/'+vhost+'/'+name,{'exchange':'commerce.events','write':r'(?!)','read':r'^catalog\.product\.(created|updated|deleted)\.v1$'})
    put('users/commerce_test' ,{'password':env['RABBITMQ_TEST_PASSWORD'],'tags':''})
    put('permissions/commerce_test/commerce_test',{'configure':r'^test_[a-z0-9_]+\..*$','write':r'^test_[a-z0-9_]+\..*$','read':r'^test_[a-z0-9_]+\..*$'})
    print('RabbitMQ users and isolated test vhost provisioned; existing messages preserved')
except Exception:
    raise SystemExit('RabbitMQ provisioning failed; check local broker readiness and credentials')
