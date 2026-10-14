// Shared expected cases used by the JS/PostgreSQL tests and read-only live checks.
const old = '2026-10-01T12:00:00Z';
const recent = '2026-10-13T12:00:00Z';
const ready = '2026-10-10T12:00:00Z';
export const processingCycleCases = [
  {name:'transport return supersedes old explicit start',data:{pastrim_started_at:old,pastrim_at:recent},expected:recent},
  {name:'base return milliseconds supersedes old explicit start',data:{pastrim_started_at:old,kthim:{active:true,at:Date.parse(recent)}},expected:recent},
  {name:'legacy returnInfo seconds',data:{pastrim_started_at:old,returnInfo:{active:true,at:Date.parse(recent)/1000}},expected:recent},
  {name:'newest-first history',data:{status_history:[{to:'pastrim',at:recent},{to:'gati',at:ready},{to:'pastrim',at:old}]},expected:recent},
  {name:'unordered histories and aliases',data:{status_history:[{to:'pastrim',at:old},{to:'gati',at:ready}],statusHistory:[{nextStatus:' PASTRIM ',ts:recent}]},expected:recent},
  {name:'outer stale metadata cannot hide newer nested history',data:{pastrim_at:old,status_history:[],data:{pastrim_at:recent,status_history:[{status:'pastrim',at:recent}]}},expected:recent},
  {name:'destination wins over prior status',data:{status_history:[{status:'gati',to:'pastrim',created_at:recent}]},expected:recent},
  {name:'blank destination alias falls through',data:{status_history:[{to:' ',next_status:'IN_BASE',at:recent}]},expected:recent},
  {name:'skip invalid history timestamp and use valid event field',data:{status_history:[null,{to:'pastrim',at:recent},{to:'pastrim',at:'invalid',ts:Date.parse(old)}]},expected:recent},
  {name:'newer generic edit and admission do not restart explicit clock',data:{pastrim_at:old},created_at:recent,updated_at:recent,expected:old},
  {name:'admission fallback',data:{},created_at:old,updated_at:recent,expected:old},
  {name:'nested admission fallback',data:{data:{ts:Date.parse(old)}},expected:old},
  {name:'unknown date',data:{pastrim_at:'invalid',status_history:'invalid'},expected:null},
  {name:'later ready evidence blocks previous-cycle fallback',data:{pastrim_started_at:old,status_history:[{to:'gati',at:ready}]},created_at:old,expected:null},
  {name:'row ready evidence blocks admission fallback',data:{},ready_at:ready,created_at:old,expected:null},
  {name:'dated return supersedes old ready',data:{pastrim_started_at:old,kthim:{at:recent}},ready_at:ready,expected:recent},
  {name:'inactive return metadata ignored',data:{pastrim_at:old,kthim:{active:false,at:recent}},expected:old},
  {name:'server clock overrides old and future device clocks',data:{inventory_processing_started_at:recent,pastrim_started_at:old,pastrim_at:'2099-01-01T00:00:00Z'},expected:recent},
  {name:'invalid server clock fails closed',data:{inventory_processing_started_at:null,pastrim_at:old},expected:null},
  {name:'processing timestamp in seconds',data:{pastrim_at:Date.parse(recent)/1000},expected:recent},
  {name:'processing timestamp in milliseconds',data:{pastrim_at:Date.parse(recent)},expected:recent},
  {name:'history across all processing aliases',data:{status_history:[{to:'base',at:old},{to:'at_base',at:recent},{to:'pastrimi',at:old}]},expected:recent},
];
export const processingCycleRow = ({expected,name,...row}) => ({status:'pastrim',...row});
