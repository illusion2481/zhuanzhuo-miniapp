const fs=require("fs"),path=require("path");
const MP="E:/WeChatProjects/zhuanzhuo-miniapp/miniprogram";
const TD=MP+"/miniprogram_npm/tdesign-miniprogram";
const bare=/(\bfrom\s*["']tslib["'])|(require\(\s*["']tslib["']\s*\))/;
let b=0;
function walk(d){if(!fs.existsSync(d))return[];let o=[];for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())o=o.concat(walk(f));else if(e.isFile()&&f.endsWith(".js"))o.push(f);}return o;}
for(const f of walk(TD)){const c=fs.readFileSync(f,"utf8");if(bare.test(c))b++;}
console.log("bare tslib refs remaining:",b);
console.log("miniprogram_npm/tslib exists:",fs.existsSync(MP+"/miniprogram_npm/tslib/tslib.js"));
console.log("miniprogram/node_modules/tslib exists:",fs.existsSync(MP+"/node_modules/tslib/tslib.js"));
console.log("miniprogram/package.json deps:",JSON.stringify(JSON.parse(fs.readFileSync(MP+"/package.json","utf8")).dependencies));
const btn=fs.readFileSync(TD+"/button/button.js","utf8");const i=btn.indexOf("tslib");
console.log("button.js => ..."+btn.slice(Math.max(0,i-30),i+30)+"...");
