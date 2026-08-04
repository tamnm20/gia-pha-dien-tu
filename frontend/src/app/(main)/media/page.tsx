'use client';

import { useEffect, useState, useCallback } from 'react';
import { MessageSquarePlus, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/components/auth-provider';
import { supabase } from '@/lib/supabase';

interface ContributionItem {
    id: string;
    author_id: string;
    author_email: string;
    person_handle: string;
    person_name: string;
    field_name: string;
    field_label: string;
    old_value: string | null;
    new_value: string;
    note: string | null;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
}

const STATE_BADGE: Record<string, { variant: 'default' | 'secondary' | 'destructive'; label: string }> = {
    pending: { variant: 'secondary', label: 'Chờ duyệt' },
    approved: { variant: 'default', label: 'Đã duyệt' },
    rejected: { variant: 'destructive', label: 'Bị từ chối' },
};

export default function ContributionsReviewPage() {
    const { isAdmin } = useAuth();
    const [items, setItems] = useState<ContributionItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('pending');

    // Fetch dữ liệu từ bảng `contributions` thay vì `media`
    const fetchContributions = useCallback(async (status?: string) => {
        setLoading(true);
        let query = supabase
            .from('contributions')
            .select('*')
            .order('created_at', { ascending: false });

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) {
            console.error('Lỗi fetch contributions:', error);
        } else if (data) {
            setItems(data as ContributionItem[]);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchContributions(tab === 'all' ? undefined : tab);
    }, [tab, fetchContributions]);

    // Hàm xử lý duyệt đóng góp
    const handleAction = async (item: ContributionItem, action: 'approve' | 'reject') => {
        if (action === 'approve') {
            const targetHandle = item.person_handle;
            const fieldName = item.field_name;
            const rawValue = item.new_value;

            if (!targetHandle || !fieldName || rawValue === undefined || rawValue === null) {
                alert('Lỗi: Bản ghi đóng góp bị thiếu person_handle hoặc field_name!');
                return;
            }

            // Ép kiểu số cho các trường năm sinh, năm mất, thế hệ...
            const isNumericField = ['birth_year', 'death_year', 'generation', 'gender'].includes(fieldName);
            const finalValue = isNumericField ? parseInt(rawValue, 10) : rawValue.trim();

            // 1. Lưu thông tin mới vào bảng `people`
            const { error: updatePeopleError } = await supabase
                .from('people')
                .update({ [fieldName]: finalValue })
                .eq('handle', targetHandle);

            if (updatePeopleError) {
                alert(`Lỗi khi cập nhật bảng people: ${updatePeopleError.message}`);
                return;
            }

            // 2. Đổi status đóng góp thành `approved` trong bảng `contributions`
            const { error: updateStatusError } = await supabase
                .from('contributions')
                .update({ status: 'approved' })
                .eq('id', item.id);

            if (updateStatusError) {
                alert(`Lỗi khi đổi trạng thái đóng góp: ${updateStatusError.message}`);
                return;
            }

            alert(`✅ Đã duyệt và lưu "${item.field_label}: ${rawValue}" cho ${item.person_name} vào CSDL!`);
            fetchContributions(tab === 'all' ? undefined : tab);

        } else {
            // Từ chối đóng góp
            const { error } = await supabase
                .from('contributions')
                .update({ status: 'rejected' })
                .eq('id', item.id);

            if (!error) {
                fetchContributions(tab === 'all' ? undefined : tab);
            } else {
                alert(`Lỗi từ chối: ${error.message}`);
            }
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                        <MessageSquarePlus className="h-6 w-6 text-blue-600" />
                        Kiểm duyệt đóng góp
                    </h1>
                    <p className="text-muted-foreground">Xem xét và phê duyệt các thông tin đóng góp từ thành viên</p>
                </div>
            </div>

            <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                    <TabsTrigger value="pending">Chờ duyệt</TabsTrigger>
                    <TabsTrigger value="approved">Đã duyệt</TabsTrigger>
                    <TabsTrigger value="rejected">Bị từ chối</TabsTrigger>
                    <TabsTrigger value="all">Tất cả</TabsTrigger>
                </TabsList>
            </Tabs>

            {loading ? (
                <div className="flex items-center justify-center h-48">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                </div>
            ) : items.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                        <MessageSquarePlus className="h-12 w-12 text-muted-foreground mb-4" />
                        <p className="text-muted-foreground">Không có đóng góp nào</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => (
                        <Card key={item.id} className="border shadow-sm">
                            <CardContent className="p-4 space-y-3">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="font-semibold text-sm text-foreground">{item.person_name}</p>
                                        <p className="text-xs text-blue-600 font-medium">Mã: {item.person_handle}</p>
                                    </div>
                                    <Badge variant={STATE_BADGE[item.status]?.variant || 'secondary'}>
                                        {STATE_BADGE[item.status]?.label || item.status}
                                    </Badge>
                                </div>

                                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-xs space-y-1">
                                    <p className="text-muted-foreground">
                                        Trường đóng góp: <strong className="text-foreground">{item.field_label} ({item.field_name})</strong>
                                    </p>
                                    <p className="text-muted-foreground">
                                        Giá trị mới: <strong className="text-green-700 bg-green-50 px-1.5 py-0.5 rounded border border-green-200">{item.new_value}</strong>
                                    </p>
                                    {item.note && (
                                        <p className="text-muted-foreground italic pt-1 border-t border-slate-200 mt-1">
                                            Ghi chú: "{item.note}"
                                        </p>
                                    )}
                                </div>

                                <p className="text-[11px] text-muted-foreground">
                                    Người gửi: {item.author_email} · {new Date(item.created_at).toLocaleDateString('vi-VN')}
                                </p>

                                {isAdmin && item.status === 'pending' && (
                                    <div className="flex gap-2 pt-1">
                                        <Button size="sm" variant="default" className="flex-1 bg-green-600 hover:bg-green-700" onClick={() => handleAction(item, 'approve')}>
                                            <Check className="h-3.5 w-3.5 mr-1" /> Duyệt & Áp dụng
                                        </Button>
                                        <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleAction(item, 'reject')}>
                                            <X className="h-3.5 w-3.5 mr-1" /> Từ chối
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}