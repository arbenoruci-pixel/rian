
// 🔥 DOCTOR ULTRA DB VIEW
// Put inside /doctor page component render()

function showUltraDbLogs(){
  try{
    const logs = JSON.parse(localStorage.getItem("DOC_DB_ULTRA_LOG")||"[]");
    console.log("ULTRA DB LOGS:",logs);
    alert(JSON.stringify(logs.slice(-5),null,2));
  }catch(e){
    alert("NO ULTRA LOGS");
  }
}

// Add button somewhere:
// <button onClick={showUltraDbLogs}>ULTRA DB</button>
