// api/index.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();

// إعدادات أساسية
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// إعداد الاتصال بقيود
const qoyodClient = axios.create({
    baseURL: 'https://www.qoyod.com/api/2.0',
    headers: {
        'API-KEY': process.env.QOYOD_API_KEY,
        'Content-Type': 'application/json'
    }
});

// ==========================================
// 1. مسار جلب الحسابات (مع إصلاح الأسماء)
// ==========================================
app.get('/api/accounts', async (req, res) => {
    try {
        const response = await qoyodClient.get('/accounts');
        const accounts = response.data.accounts || [];

        const validAccounts = accounts
            // فلترة ذكية: نجلب الحسابات التي يُتوقع أنها للدفع
            .filter(acc => {
                // دمج الأسماء للبحث
                const fullName = (acc.name_ar + " " + acc.name_en + " " + acc.name).toLowerCase();
                
                // كلمات مفتاحية لحسابات الدفع
                const isPaymentAccount = 
                    fullName.includes('bank') || 
                    fullName.includes('cash') || 
                    fullName.includes('بنك') || 
                    fullName.includes('نقد') || 
                    fullName.includes('صندوق') || 
                    fullName.includes('عهدة') ||
                    acc.category_id === 1; // رقم 1 عادة هو الأصول المتداولة
                
                return isPaymentAccount; 
            })
            .map(acc => ({
                id: acc.id,
                // ✅ هنا الإصلاح: البحث عن الاسم في جميع الحقول المتاحة
                name: acc.name_ar || acc.name || acc.name_en || "حساب بدون اسم", 
                balance: acc.balance,
                currency: acc.currency || 'SAR'
            }));

        res.json(validAccounts);

    } catch (error) {
        console.error("Error fetching accounts:", error.message);
        res.status(500).json({ 
            error: 'فشل جلب الحسابات', 
            details: error.response ? error.response.data : error.message 
        });
    }
});

// ==========================================
// 2. مسار الدفع (مع كشف الأخطاء)
// ==========================================
app.post('/api/pay', async (req, res) => {
    const { type, ref, accountId } = req.body;
    const endpoint = type === 'sales' ? 'invoices' : 'bills';

    try {
        // أ) البحث عن الفاتورة
        const searchRes = await qoyodClient.get(`/${endpoint}`, {
            params: { 'q[reference_eq]': ref }
        });

        const list = searchRes.data[endpoint];
        if (!list || list.length === 0) {
            return res.json({ status: 'error', message: 'غير موجودة في النظام' });
        }

        const invoice = list[0];

        // ب) التحقق من الحالة
        if (invoice.status === 'Paid') {
            return res.json({ status: 'skipped', message: 'مدفوعة مسبقاً' });
        }

        // ج) محاولة الدفع
        const paymentEndpoint = type === 'sales' 
            ? `/invoices/${invoice.id}/payments` 
            : `/bills/${invoice.id}/payments`;

        const payloadKey = type === 'sales' ? 'invoice_payment' : 'bill_payment';
        
        const paymentData = {
            [payloadKey]: {
                reference: `AUTO-${Date.now()}`,
                account_id: accountId,
                amount: invoice.due_amount,
                date: new Date().toISOString().split('T')[0]
            }
        };

        await qoyodClient.post(paymentEndpoint, paymentData);
        
        // نجاح العملية
        res.json({ status: 'success', amount: invoice.due_amount });

    } catch (error) {
        // ✅ هنا التعديل المهم: استخراج رسالة الخطأ الحقيقية من قيود
        const apiError = error.response && error.response.data 
            ? error.response.data 
            : error.message;

        console.error(`Failed to pay ${ref}:`, JSON.stringify(apiError));

        res.json({ 
            status: 'error', 
            message: 'رفض من قيود', 
            details: apiError // إرسال تفاصيل الخطأ للواجهة
        });
    }
});

module.exports = app;
