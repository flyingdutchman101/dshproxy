'use strict';
const fs=require('node:fs'); const path=require('node:path');
const {homeDir}=require('../settings');
const {withLock,replaceFile}=require('../filelock');
const ID='ad-research/foreplay';
const entry={id:ID,label:'Ad research – Foreplay',route:'foreplay',model:'ad-research'};
function file(home=homeDir()){return path.join(home,'provider-picker.json');}
function enabled(home){try{return JSON.parse(fs.readFileSync(file(home),'utf8')).foreplay===true;}catch{return false;}}
async function set(home,on){const target=file(home);fs.mkdirSync(path.dirname(target),{recursive:true});await withLock(target,()=>replaceFile(target,JSON.stringify({foreplay:on===true})+'\n'));}
module.exports={ID,entry,enabled,set};
