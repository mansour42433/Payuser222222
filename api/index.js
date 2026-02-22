const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 🛡️ الحارس الأمني
app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) return next();
    const clientPass = req.headers['x-app-password'];
    const serverPass = process.env.APP_PASSWORD;
    if (!serverPass) return next();
    if (clientPass === serverPass) next();
    else res.status(401).json({ status: 'error', message: 'كلمة المرور خاطئة' });
});

const qoyodClient = axios.create({
    baseURL: 'https://api.qoyod.com/2.0',
    headers: {
        'API-KEY': process.env.QOYOD_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

app.post('/api/login', (req, res) => res.json({ status: 'success' }));

// 🛡️ اختبار الاتصال بـ قيود
app.get('/api/test-connection', async (req, res) => {
    try {
        const response = await qoyodClient.get('/accounts');
        res.json({ status: 'success', message: 'تم الاتصال بـ قيود بنجاح', count: response.data.accounts?.length });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: 'فشل الاتصال بـ قيود', 
            details: error.response?.data || error.message 
        });
    }
});

// 1. جلب الحسابات
app.get('/api/accounts', async (req, res) => {
    try {
        const response = await qoyodClient.get('/accounts');
        const accounts = response.data.accounts || [];
        const validAccounts = accounts.map(acc => {
            let name = acc.name_ar || acc.name || acc.name_en || "بدون اسم";
            if (acc.code) name = `${acc.code} - ${name}`;
            return { id: acc.id, name: name, raw: name.toLowerCase() };
        });
        const filtered = validAccounts.filter(acc => {
            const n = acc.raw;
            return (n.includes('1101') || n.includes('1102') || n.includes('bank') || n.includes('cash') || n.includes('نقد') || n.includes('بنك')) 
                   && !n.includes('مخزون') && !n.includes('مدينون');
        });
        res.json(filtered.length > 0 ? filtered : validAccounts);
    } catch (error) {
        res.status(500).json({ error: 'فشل جلب الحسابات' });
    }
});

// 2. معاينة الفاتورة (معدل لجلب منشئ الفاتورة والمخزن)
app.post('/api/preview', async (req, res) => {
    const { type, ref } = req.body;
    const endpoint = type === 'sales' ? 'invoices' : 'bills';
    try {
        const searchRes = await qoyodClient.get(`/${endpoint}`, { params: { 'q[reference_eq]': ref } });
        const list = searchRes.data[endpoint];
        if (!list || list.length === 0) return res.json({ status: 'not_found', message: 'غير موجودة' });

        const summaryInv = list[0];
        
        // جلب تفاصيل كاملة للحصول على المستخدم والمستودع
        let inv = summaryInv;
        try {
            const detailRes = await qoyodClient.get(`/${endpoint}/${summaryInv.id}`);
            inv = detailRes.data.invoice || detailRes.data.bill || summaryInv;
        } catch (e) {
            console.error("Error fetching detail:", e.message);
        }

        let contactName = inv.contact_name || (inv.contact ? inv.contact.name : "غير محدد");
        
        if ((!contactName || contactName === "غير محدد") && inv.contact_id) {
            try {
                const cEnd = type === 'sales' ? `/customers/${inv.contact_id}` : `/vendors/${inv.contact_id}`;
                const cRes = await qoyodClient.get(cEnd);
                const cData = cRes.data.customer || cRes.data.vendor || cRes.data.contact;
                if(cData) contactName = cData.name || cData.organization;
            } catch(e) {}
        }

        // استخراج اسم المستخدم (المنشئ) واسم المستودع
        const userName = inv.user ? (inv.user.name || inv.user.full_name) : "غير معروف";
        const inventoryName = inv.inventory ? inv.inventory.name : (inv.location ? inv.location.name : "غير محدد");

        return res.json({
            status: 'found',
            id: inv.id,
            ref: inv.reference,
            contact: contactName,
            issue_date: inv.issue_date,
            total: inv.total_amount,
            due: inv.due_amount,
            inv_status: inv.status,
            user_name: userName,
            inventory_name: inventoryName
        });
    } catch (error) {
        return res.json({ status: 'error', message: 'خطأ اتصال' });
    }
});

// 3. الدفع
app.post('/api/pay', async (req, res) => {
    const { type, ref, accountId, forceAmount, forceDate } = req.body;
    const isSales = type === 'sales';
    const endpointPay = isSales ? '/invoice_payments' : '/bill_payments';
    const payloadKey = isSales ? 'invoice_payment' : 'bill_payment';
    const idKey = isSales ? 'invoice_id' : 'bill_id';
    const endpointSearch = isSales ? 'invoices' : 'bills';

    try {
        const searchRes = await qoyodClient.get(`/${endpointSearch}`, { params: { 'q[reference_eq]': ref } });
        const list = searchRes.data[endpointSearch];
        if (!list || list.length === 0) return res.json({ status: 'error', message: 'غير موجودة' });

        const inv = list[0];
        if (inv.status === 'Paid') return res.json({ status: 'skipped', message: 'مدفوعة مسبقاً' });

        let amount = forceAmount && parseFloat(forceAmount) > 0 ? String(forceAmount) : String(inv.due_amount);
        let date = forceDate || new Date(new Date().getTime() + (3 * 60 * 60 * 1000)).toISOString().split('T')[0];

        await qoyodClient.post(endpointPay, {
            [payloadKey]: {
                reference: `PAY-${Date.now()}`,
                [idKey]: String(inv.id),
                account_id: String(accountId),
                date: date,
                amount: amount
            }
        });
        res.json({ status: 'success', amount, date });
    } catch (error) {
        res.json({ status: 'error', message: 'رفض العملية', details: error.response?.data || error.message });
    }
});

// 4. الإرجاع (محدّث: تسمية CRN تسلسلي + إصلاح الوحدات + إصلاح التخصيص وإرجاع الأموال)
app.post('/api/return', async (req, res) => {
    const { ref, returnType, accountId } = req.body;

    try {
        // أ) البحث عن الفاتورة
        const resSearch = await qoyodClient.get('/invoices', { params: { 'q[reference_eq]': ref } });
        if (!resSearch.data.invoices || resSearch.data.invoices.length === 0) {
            return res.json({ status: 'error', message: 'الفاتورة غير موجودة' });
        }
        const summaryInv = resSearch.data.invoices[0];

        // ب) جلب التفاصيل الكاملة للفاتورة (تشمل line_items مع unit_type)
        const detailRes = await qoyodClient.get(`/invoices/${summaryInv.id}`);
        const inv = detailRes.data.invoice || summaryInv;

        // ج) تحديد المستودع
        let targetInventoryId = null;
        if (inv.inventory_id) targetInventoryId = String(inv.inventory_id);
        else if (inv.location_id) targetInventoryId = String(inv.location_id);
        else if (inv.line_items && inv.line_items.length > 0 && inv.line_items[0].inventory_id) {
            targetInventoryId = String(inv.line_items[0].inventory_id);
        }

        if (!targetInventoryId) {
            return res.json({ status: 'error', message: 'الفاتورة الأصلية لا تحتوي على مستودع (Inventory ID)' });
        }

        // د) بناء line_items مع الحفاظ على نفس الوحدة (unit_type) من الفاتورة الأصلية
        const creditLineItems = (inv.line_items || []).map(item => {
            const lineItem = {
                product_id: item.product_id,
                description: item.description || "استرجاع",
                quantity: item.quantity,
                unit_price: item.unit_price,
                discount_percent: item.discount_percent || "0.0",
                tax_percent: item.tax_percent
            };
            // إصلاح مشكلة الوحدات: نسخ unit_type من الفاتورة الأصلية
            if (item.unit_type) {
                lineItem.unit_type = String(item.unit_type);
            } else if (item.unit_type_id) {
                lineItem.unit_type = String(item.unit_type_id);
            } else if (item.unit_id) {
                lineItem.unit_type = String(item.unit_id);
            }
            return lineItem;
        });

        // هـ) توليد رقم مرجعي بصيغة CRN+تسلسلي-رقم الفاتورة
        let crnSequence = 1;
        try {
            const existingCNs = await qoyodClient.get('/credit_notes');
            const allCNs = existingCNs.data.credit_notes || [];
            if (allCNs.length > 0) {
                // حساب الرقم التسلسلي التالي بناءً على عدد الإشعارات الموجودة
                const crnNumbers = allCNs
                    .map(cn => {
                        const match = (cn.reference || '').match(/^CRN(\d+)-/);
                        return match ? parseInt(match[1]) : 0;
                    })
                    .filter(n => n > 0);
                if (crnNumbers.length > 0) {
                    crnSequence = Math.max(...crnNumbers) + 1;
                } else {
                    // إذا لم تكن هناك إشعارات بصيغة CRN، نبدأ من عدد الإشعارات + 1
                    crnSequence = allCNs.length + 1;
                }
            }
        } catch (e) {
            crnSequence = Date.now().toString().slice(-4);
        }

        const uniqueRef = `CRN${crnSequence}-${inv.reference}`;
        const todayDate = new Date(new Date().getTime() + (3 * 60 * 60 * 1000)).toISOString().split('T')[0];
        
        const cnPayload = {
            credit_note: {
                contact_id: inv.contact_id,
                reference: uniqueRef,
                issue_date: todayDate,
                status: "Approved",
                inventory_id: targetInventoryId,
                parent_id: inv.id,
                line_items: creditLineItems
            }
        };

        console.log("Credit Note Payload:", JSON.stringify(cnPayload, null, 2));

        const resCN = await qoyodClient.post('/credit_notes', cnPayload);
        const creditNote = resCN.data.credit_note || resCN.data.note || resCN.data;
        const cnId = creditNote.id;
        const cnTotal = creditNote.total_amount || creditNote.total;

        if (!cnId) {
            return res.json({ status: 'error', message: 'فشل إنشاء إشعار الدائن - لم يتم الحصول على ID', details: resCN.data });
        }

        console.log(`Credit Note Created: ID=${cnId}, Total=${cnTotal}, Ref=${uniqueRef}`);

        if (returnType === 'refund') {
            // ===== إرجاع أموال نقدي: POST /credit_note_payments =====
            try {
                const refundRes = await qoyodClient.post('/credit_note_payments', {
                    credit_note_payment: {
                        credit_note_id: String(cnId),
                        account_id: String(accountId),
                        amount: String(cnTotal),
                        date: todayDate
                    }
                });
                console.log(`Refund Done: CreditNote ${cnId} -> Account ${accountId}`, refundRes.data);

                return res.json({ 
                    status: 'success', 
                    message: `تم الإرجاع + استرداد نقدي ✅ | المرجع: ${uniqueRef}` 
                });
            } catch (refundError) {
                console.error("Refund Error:", JSON.stringify(refundError.response?.data || refundError.message));
                return res.json({ 
                    status: 'partial', 
                    message: `تم إنشاء إشعار الدائن ${uniqueRef} لكن فشل إرجاع الأموال`,
                    details: refundError.response?.data || refundError.message
                });
            }
        } else {
            // ===== تخصيص للفاتورة: POST /credit_notes/{id}/allocations =====
            try {
                const allocRes = await qoyodClient.post(`/credit_notes/${cnId}/allocations`, {
                    allocation: {
                        invoice_id: String(inv.id),
                        amount: String(cnTotal)
                    }
                });
                console.log(`Allocation Done: CreditNote ${cnId} -> Invoice ${inv.id}`, allocRes.data);

                return res.json({ 
                    status: 'success', 
                    message: `تم الإرجاع + تخصيص إشعار الدائن للفاتورة ✅ | المرجع: ${uniqueRef}` 
                });
            } catch (allocError) {
                console.error("Allocation Error:", JSON.stringify(allocError.response?.data || allocError.message));
                return res.json({ 
                    status: 'partial', 
                    message: `تم إنشاء إشعار الدائن ${uniqueRef} لكن فشل التخصيص`,
                    details: allocError.response?.data || allocError.message
                });
            }
        }

    } catch (error) {
        console.error("Return Failed:", error.message);
        let details = error.response?.data || error.message;
        res.json({ status: 'error', message: 'فشل الإرجاع', details: details });
    }
});

module.exports = app;
