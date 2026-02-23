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

// 2. معاينة الفاتورة
app.post('/api/preview', async (req, res) => {
    const { type, ref } = req.body;
    const endpoint = type === 'sales' ? 'invoices' : 'bills';
    try {
        const searchRes = await qoyodClient.get(`/${endpoint}`, { params: { 'q[reference_eq]': ref } });
        const list = searchRes.data[endpoint];
        if (!list || list.length === 0) return res.json({ status: 'not_found', message: 'غير موجودة' });

        const summaryInv = list[0];
        
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

// 4. الإرجاع (المطابق حرفياً للـ API Docs)
app.post('/api/return', async (req, res) => {
    const { ref, returnType, accountId } = req.body;

    try {
        const resSearch = await qoyodClient.get('/invoices', { params: { 'q[reference_eq]': ref } });
        if (!resSearch.data.invoices || resSearch.data.invoices.length === 0) {
            return res.json({ status: 'error', message: 'الفاتورة غير موجودة' });
        }
        const summaryInv = resSearch.data.invoices[0];

        const detailRes = await qoyodClient.get(`/invoices/${summaryInv.id}`);
        const inv = detailRes.data.invoice || summaryInv;

        let targetInventoryId = "1";
        if (inv.inventory_id) targetInventoryId = String(inv.inventory_id);
        else if (inv.location_id) targetInventoryId = String(inv.location_id);
        else if (inv.line_items && inv.line_items.length > 0 && inv.line_items[0].inventory_id) {
            targetInventoryId = String(inv.line_items[0].inventory_id);
        }

        // بناء الـ line_items بناءً على التوثيق الرسمي فقط (بدون أي إضافات خارجية)
        const creditLineItems = (inv.line_items || []).map(item => {
            const lineItem = {
                product_id: item.product_id,
                description: item.description || "استرجاع",
                unit_price: String(item.unit_price),
                quantity: String(item.quantity),
                tax_percent: item.tax_percent !== undefined ? String(item.tax_percent) : "0.0"
            };
            
            if (item.unit_type) {
                lineItem.unit_type = String(item.unit_type);
            }

            // التعامل مع الخصم بناءً على التوثيق (مبلغ أو نسبة)
            const dAmount = parseFloat(item.discount_amount || "0");
            if (dAmount > 0) {
                lineItem.discount = String(item.discount_amount);
                lineItem.discount_type = "amount";
            } else {
                lineItem.discount = String(item.discount_percent || "0.0");
                lineItem.discount_type = "percentage";
            }

            return lineItem;
        });

        // توليد الرقم المرجعي للإشعار
        let crnSequence = Date.now().toString().slice(-4);
        const uniqueRef = `CRN${crnSequence}-${inv.reference}`;
        const todayDate = new Date(new Date().getTime() + (3 * 60 * 60 * 1000)).toISOString().split('T')[0];
        
        // إرسال البيانات المعتمدة في التوثيق فقط
        const cnPayload = {
            credit_note: {
                contact_id: inv.contact_id,
                reference: uniqueRef,
                issue_date: todayDate,
                status: "Approved",
                inventory_id: targetInventoryId,
                line_items: creditLineItems
            }
        };

        const resCN = await qoyodClient.post('/credit_notes', cnPayload);
        const creditNote = resCN.data.credit_note || resCN.data.note || resCN.data;
        const cnId = creditNote.id;
        
        // أخذ الإجمالي الذي حسبه قيود بناءً على البارامترات
        const cnTotal = creditNote.total_amount || creditNote.total;
        const allocAmount = String(cnTotal);

        if (!cnId) {
            return res.json({ status: 'error', message: 'فشل إنشاء إشعار الدائن', details: resCN.data });
        }

        if (returnType === 'refund') {
            try {
                // إنشاء سند صرف لإرجاع الأموال (kind: paid)
                const receiptRes = await qoyodClient.post('receipts', {
                    receipt: {
                        reference: `REFUND-${uniqueRef}`,
                        contact_id: inv.contact_id,
                        account_id: String(accountId),
                        amount: allocAmount,
                        date: todayDate,
                        kind: 'paid'
                    }
                });
                const receipt = receiptRes.data.receipt;
                // تخصيص السند للإشعار الدائن لإغلاقه
                await qoyodClient.post(`receipts/${receipt.id}/allocations`, {
                    allocation: { allocatee_type: 'CreditNote', allocatee_id: String(cnId), amount: allocAmount }
                });
                return res.json({ status: 'success', message: `تم الإرجاع + استرداد نقدي ✅ | المرجع: ${uniqueRef}` });
            } catch (e) {
                return res.json({ status: 'partial', message: `تم إنشاء الإشعار ${uniqueRef} لكن فشل استرداد الأموال`, details: e.response?.data });
            }
        } else {
            try {
                // تخصيص الإشعار الدائن للفاتورة بحسب توثيق قيود
                await qoyodClient.post(`invoices/${inv.id}/allocations`, {
                    invoice: {
                        allocations_attributes: [{
                            source_type: 'CreditNote',
                            source_id: cnId,
                            amount: allocAmount,
                            date: todayDate
                        }]
                    }
                });
                return res.json({ status: 'success', message: `تم الإرجاع + تخصيص إشعار الدائن للفاتورة ✅ | المرجع: ${uniqueRef}` });
            } catch (e) {
                return res.json({ status: 'partial', message: `تم إنشاء الإشعار ${uniqueRef} لكن فشل التخصيص`, details: e.response?.data });
            }
        }

    } catch (error) {
        console.error("Return Failed:", error.message);
        let details = error.response?.data || error.message;
        res.json({ status: 'error', message: 'فشل الإرجاع', details: details });
    }
});

module.exports = app;
