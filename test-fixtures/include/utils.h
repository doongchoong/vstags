#ifndef UTILS_H
#define UTILS_H
#include "common.h"

/* 메시지 시스템에서 조회한 문자열 */
char *get_msg(int code);
EmpRec *find_emp(int no);
/* int64 / MONEY 는 이 저장소에 정의가 없음 */
int64 get_amount(void);
MONEY get_money(void);

#endif
