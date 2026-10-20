# UPnP IGD 小工具：list / add / del（只用標準函式庫）
import sys, re, urllib.request
LOC = "http://192.168.0.1:1900/gzwej/rootDesc.xml"
xml = urllib.request.urlopen(LOC, timeout=3).read().decode("utf-8", "ignore")
st, ctl = re.search(r"<serviceType>(urn:schemas-upnp-org:service:WANIPConnection:\d)</serviceType>.*?<controlURL>([^<]+)</controlURL>", xml, re.S).groups()
base = re.match(r"(https?://[^/]+)", LOC).group(1)
def soap(action, args):
    inner = "".join(f"<{k}>{v}</{k}>" for k, v in args.items())
    body = f"<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{st}\">{inner}</u:{action}></s:Body></s:Envelope>"
    req = urllib.request.Request(base + ctl, data=body.encode(), headers={"Content-Type": "text/xml", "SOAPAction": f"\"{st}#{action}\""})
    return urllib.request.urlopen(req, timeout=5).read().decode()
cmd = sys.argv[1]
if cmd == "list":
    i = 0
    while True:
        try: r = soap("GetGenericPortMappingEntry", {"NewPortMappingIndex": i})
        except Exception: break
        f = dict(re.findall(r"<(New\w+)>([^<]*)<", r))
        print(f["NewProtocol"], f["NewExternalPort"], "->", f["NewInternalClient"] + ":" + f["NewInternalPort"], f.get("NewPortMappingDescription"), "lease", f.get("NewLeaseDuration"))
        i += 1
    print("共", i, "筆")
elif cmd == "add":
    ext, internal, port, desc, lease = sys.argv[2:7]
    soap("AddPortMapping", {"NewRemoteHost": "", "NewExternalPort": ext, "NewProtocol": "TCP", "NewInternalPort": port, "NewInternalClient": internal, "NewEnabled": 1, "NewPortMappingDescription": desc, "NewLeaseDuration": lease})
    print("已新增", ext, "->", internal + ":" + port)
elif cmd == "del":
    soap("DeletePortMapping", {"NewRemoteHost": "", "NewExternalPort": sys.argv[2], "NewProtocol": "TCP"})
    print("已刪除", sys.argv[2])
