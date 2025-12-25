TEPIHA ARKA PATCH

Struktura:
- public/assets/arka.js       -> truni i ARKËS (roles, budget, moves, payments)
- public/assets/arka-page.js  -> lidhja me UI (butonat AVANS/SHPENZIM/TOP-UP/DITA)

Hapat për integrim:
1) Kopjo folderin 'public' nga ky patch brenda projektit tënd (bashko me public ekzistues).
2) Në faqen ARKA sigurohu që:
   - form-at kanë ID:
     * open_cash_input, btn_open_day, btn_close_day, day_info_text
     * avans_name, avans_amount, avans_source, avans_note, btn_avans
     * shpenzim_amount, shpenzim_source, shpenzim_note, btn_shpenzim
     * topup_amount, topup_who, topup_note, btn_topup
     * moves_empty, moves_list
     * user_admin_panel, user_name_input, user_pin_input, user_role_select, btn_add_user, user_list_empty, user_list
3) Ngarko script-at në faqen ARKA:
   <script src="/assets/arka.js" defer></script>
   <script src="/assets/arka-page.js" defer></script>

Admin default: PIN 4563 (krijohet automatikisht në localStorage).


=== USERS / PIN / RROGA-ORE ===
- Çdo user në ARKA ruhet te localStorage: ARKA_USERS si {id,name,role,hashedPin,hourlyRate}.
- ADMIN mund: me shto user, me ndërru rrogë/orë (hourlyRate), me resetu PIN për këdo.
- Çdo user (PUNTOR/TRANSPORT/ADMIN) mund: me ndërru PIN-in e vet (verifikon PIN aktual).
- ADMIN ka qasje edhe te WORKER/TRANSPORT/ DISPATCH panels (pa pas nevojë role dyfishe).
