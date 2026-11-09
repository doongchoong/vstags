#include "utils.h"
int t(void)
{
    char buf[40];
    char *m;
    EmpRec *e;
    int64 amt;
    MONEY won;
    m = get_msg(100);
    strcpy(buf, m);
    e = find_emp(7);
    e->sal = 10;
    amt = get_amount();
    amt = amt + 1;
    won = get_money();
    won = won / 2;
    return strlen(buf);
}
