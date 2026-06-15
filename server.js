const express=require("express");const cors=require("cors");const fs=require("fs");const path=require("path");const crypto=require("crypto");
const app=express();app.use(cors());app.use(express.json());
const PORT=process.env.PORT||3001;const DB_PATH=path.join(__dirname,"db.json");
const PACKS={basic:{name:"Basic Pack",priceUsd:10},epic:{name:"Epic Pack",priceUsd:20},legendary:{name:"Legendary Pack",priceUsd:30}};
const ARENAS={bronze:{name:"Bronze Arena",entryUsd:10},silver:{name:"Silver Arena",entryUsd:35},gold:{name:"Gold Arena",entryUsd:50}};
const PLATFORM_FEE_RATE=0;
const ONLINE_WINDOW_MS=60*1000;
function createDefaultDb(){return{users:{},treasury:{packRevenueUsd:0,arenaFeesUsd:0,totalRevenueUsd:0},queue:{bronze:[],silver:[],gold:[]},matches:{},purchases:[]};}
function loadDb(){if(!fs.existsSync(DB_PATH)){const db=createDefaultDb();saveDb(db);return db;}return JSON.parse(fs.readFileSync(DB_PATH,"utf8"));}
function saveDb(db){fs.writeFileSync(DB_PATH,JSON.stringify(db,null,2));}
function newId(p){return `${p}_${crypto.randomUUID()}`;}
function getUserOrFail(db,id){const u=db.users[id];if(!u)throw new Error("User not found");return u;}
function touch(u){if(u)u.lastSeen=Date.now();}
function sanitizeName(n){return(String(n||"Nova").replace(/[<>&"']/g,"").trim().slice(0,14)||"Nova");}
function randomRarity(w){const t=Object.values(w).reduce((a,b)=>a+b,0);let r=Math.random()*t;for(const[k,v]of Object.entries(w)){r-=v;if(r<=0)return k;}return"common";}
function randomChampion(rarity){const champs=["Pyron","Florabel","Voltik","Frostle","Umbron","Aquon"];const els=["Fire","Nature","Electric","Ice","Shadow","Water"];const i=Math.floor(Math.random()*champs.length);return{id:newId("card"),name:champs[i],element:els[i],rarity,power:rarity==="legendary"?100:rarity==="epic"?75:rarity==="rare"?50:25};}
function generatePackCards(t){const c=[];if(t==="basic"){c.push(randomChampion("rare"));while(c.length<5)c.push(randomChampion(randomRarity({common:75,rare:25})));}if(t==="epic"){c.push(randomChampion("epic"));while(c.length<5)c.push(randomChampion(randomRarity({common:20,rare:47,epic:33})));}if(t==="legendary"){c.push(randomChampion("legendary"));while(c.length<5)c.push(randomChampion(randomRarity({epic:70,legendary:30})));}return c;}
// --- Elo (K=32) ---
function applyElo(winner,loser,K=32){const ea=1/(1+Math.pow(10,(loser.elo-winner.elo)/400));winner.elo=Math.round(winner.elo+K*(1-ea));loser.elo=Math.max(100,Math.round(loser.elo+K*(0-(1-ea))));}
function userQueueState(db,userId){const m=Object.values(db.matches).find(m=>m.status==="active"&&(m.playerA===userId||m.playerB===userId));if(m)return{state:"matched",match:m};for(const a of Object.keys(db.queue)){const t=db.queue[a].find(t=>t.userId===userId);if(t)return{state:"queued",ticket:t};}return{state:"idle"};}

app.get("/",(req,res)=>res.json({success:true,message:"Valora V1 backend is running"}));
app.post("/api/users",(req,res)=>{const db=loadDb();const id=newId("user");const username=sanitizeName(req.body.username);db.users[id]={id,username,walletAddress:null,balanceUsd:125,lockedUsd:0,elo:1800,wins:0,losses:0,cards:[],createdAt:Date.now(),lastSeen:Date.now()};saveDb(db);res.json({success:true,user:db.users[id]});});
app.get("/api/users/:userId",(req,res)=>{try{const db=loadDb();const u=getUserOrFail(db,req.params.userId);touch(u);saveDb(db);res.json({success:true,user:u});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.post("/api/heartbeat",(req,res)=>{const db=loadDb();const u=db.users[req.body.userId];if(u){touch(u);saveDb(db);}res.json({success:true});});
app.get("/api/online",(req,res)=>{const db=loadDb();const now=Date.now();const online=Object.values(db.users).filter(u=>now-(u.lastSeen||0)<ONLINE_WINDOW_MS).length;res.json({success:true,online});});
app.get("/api/leaderboard",(req,res)=>{const db=loadDb();const all=Object.values(db.users).map(u=>({id:u.id,username:u.username,elo:u.elo,wins:u.wins||0,losses:u.losses||0}));all.sort((a,b)=>b.elo-a.elo);res.json({success:true,total:all.length,top:all.slice(0,50)});});
app.post("/api/users/:userId/rename",(req,res)=>{try{const db=loadDb();const u=getUserOrFail(db,req.params.userId);u.username=sanitizeName(req.body.username);saveDb(db);res.json({success:true,user:u});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.post("/api/users/:userId/connect-wallet",(req,res)=>{try{const db=loadDb();const u=getUserOrFail(db,req.params.userId);const w=String(req.body.walletAddress||"").trim();if(!w)throw new Error("Wallet address required");u.walletAddress=w;saveDb(db);res.json({success:true,user:u});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.post("/api/users/:userId/faucet",(req,res)=>{try{const db=loadDb();const u=getUserOrFail(db,req.params.userId);const a=Number(req.body.amountUsd||100);if(a<=0)throw new Error("Invalid faucet amount");u.balanceUsd+=a;saveDb(db);res.json({success:true,addedUsd:a,user:u});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.post("/api/packs/buy",(req,res)=>{try{const db=loadDb();const{userId,packType}=req.body;const pack=PACKS[packType];if(!pack)throw new Error("Invalid pack type");const u=getUserOrFail(db,userId);if(u.balanceUsd<pack.priceUsd)throw new Error("Not enough balance");u.balanceUsd-=pack.priceUsd;const cards=generatePackCards(packType);u.cards.push(...cards);const purchase={id:newId("purchase"),userId,packType,priceUsd:pack.priceUsd,cards,status:"completed",createdAt:Date.now()};db.purchases.push(purchase);db.treasury.packRevenueUsd+=pack.priceUsd;db.treasury.totalRevenueUsd+=pack.priceUsd;saveDb(db);res.json({success:true,purchase,user:u,treasury:db.treasury});}catch(e){res.status(400).json({success:false,error:e.message});}});
// arena status poll (queued player learns it's matched)
app.get("/api/arena/status",(req,res)=>{try{const db=loadDb();const userId=req.query.userId;getUserOrFail(db,userId);res.json({success:true,...userQueueState(db,userId)});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.post("/api/arena/join",(req,res)=>{try{const db=loadDb();const{userId,arenaId}=req.body;const arena=ARENAS[arenaId];if(!arena)throw new Error("Invalid arena");const u=getUserOrFail(db,userId);touch(u);
  const cur=userQueueState(db,userId);if(cur.state!=="idle"){saveDb(db);return res.json({success:true,status:cur.state,...cur,user:u,message:"Already "+cur.state});}
  if(u.balanceUsd<arena.entryUsd)throw new Error("Not enough balance");
  u.balanceUsd-=arena.entryUsd;u.lockedUsd+=arena.entryUsd;
  const ticket={id:newId("ticket"),userId,arenaId,entryUsd:arena.entryUsd,createdAt:Date.now()};
  const q=db.queue[arenaId];const oi=q.findIndex(x=>x.userId!==userId);
  if(oi===-1){q.push(ticket);saveDb(db);return res.json({success:true,status:"queued",ticket,user:u,message:`Searching opponent in ${arena.name}`});}
  const ot=q.splice(oi,1)[0];const opp=getUserOrFail(db,ot.userId);const matchId=newId("match");
  const match={id:matchId,arenaId,arenaName:arena.name,playerA:opp.id,playerANick:opp.username,playerB:u.id,playerBNick:u.username,entryUsd:arena.entryUsd,potUsd:arena.entryUsd*2,status:"active",winnerId:null,createdAt:Date.now()};
  db.matches[matchId]=match;saveDb(db);res.json({success:true,status:"matched",match,players:{playerA:opp,playerB:u}});
}catch(e){res.status(400).json({success:false,error:e.message});}});
app.post("/api/arena/cancel",(req,res)=>{try{const db=loadDb();const{userId,ticketId}=req.body;let ft=null;for(const a of Object.keys(db.queue)){const i=db.queue[a].findIndex(t=>(ticketId?t.id===ticketId:true)&&t.userId===userId);if(i!==-1){ft=db.queue[a].splice(i,1)[0];break;}}if(!ft)throw new Error("Queue ticket not found");const u=getUserOrFail(db,userId);u.lockedUsd-=ft.entryUsd;u.balanceUsd+=ft.entryUsd;saveDb(db);res.json({success:true,refundedUsd:ft.entryUsd,user:u});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.get("/api/matches/:matchId",(req,res)=>{try{const db=loadDb();const m=db.matches[req.params.matchId];if(!m)throw new Error("Match not found");res.json({success:true,match:m});}catch(e){res.status(400).json({success:false,error:e.message});}});
app.post("/api/matches/:matchId/finish",(req,res)=>{try{const db=loadDb();const m=db.matches[req.params.matchId];if(!m)throw new Error("Match not found");if(m.status!=="active")throw new Error("Match already finished");const{winnerId}=req.body;if(![m.playerA,m.playerB].includes(winnerId))throw new Error("Invalid winner");
  // NOTE V1: trusts client-reported winner. TODO: server-authoritative validation before real money.
  const loserId=winnerId===m.playerA?m.playerB:m.playerA;const winner=getUserOrFail(db,winnerId);const loser=getUserOrFail(db,loserId);
  const entry=m.entryUsd,pot=m.potUsd;const fee=Number((pot*PLATFORM_FEE_RATE).toFixed(2));const prize=Number((pot-fee).toFixed(2));
  winner.lockedUsd-=entry;loser.lockedUsd-=entry;winner.balanceUsd+=prize;
  applyElo(winner,loser);winner.wins=(winner.wins||0)+1;loser.losses=(loser.losses||0)+1;
  db.treasury.arenaFeesUsd+=fee;db.treasury.totalRevenueUsd+=fee;
  m.status="finished";m.winnerId=winnerId;m.loserId=loserId;m.prizeUsd=prize;m.feeUsd=fee;m.finishedAt=Date.now();
  saveDb(db);res.json({success:true,match:m,winner,loser,prizeUsd:prize,feeUsd:fee,treasury:db.treasury});
}catch(e){res.status(400).json({success:false,error:e.message});}});
app.get("/api/treasury",(req,res)=>{const db=loadDb();res.json({success:true,treasury:db.treasury,purchases:db.purchases.length,activeMatches:Object.values(db.matches).filter(m=>m.status==="active").length,finishedMatches:Object.values(db.matches).filter(m=>m.status==="finished").length});});
app.listen(PORT,()=>console.log(`Valora V1 backend running on http://localhost:${PORT}`));
